// Journey 3 (foreign HTML permission adversarial): the sandboxed iframe is
// treated as the attacker inside real Chrome.
//   Credential isolation: with network on, fetch can "cross the line" and reach
//     the 127.0.0.1 daemon (CSP connect-src allows http:), but opaque origin +
//     HttpOnly + SameSite=Strict triple-guarantee the request never carries the
//     hr cookie — reads come back as opaque shells, writes are 401-rejected
//     (proven by the server-side grant staying unchanged).
//     connect-src 'self' (once same-directory resources are allowed) likewise
//     lets requests out to 127.0.0.1 — the missing cookie still means 401/403
//     + no ACAO, and the response is confiscated all the same.
//   The fourth quadrant (scripts off + network on): meta-CSP override, <base>
//     hijack, external script, event-handler attributes, javascript: — all stay
//     silent; the HTTP-header CSP delivered later only adds on top, a meta
//     override has no effect.
//   Global modes: writing any of the three modes immediately pushes
//     permissions.changed; the bottom-bar switches grey out as "centrally
//     controlled by settings".
//   Path semantics: rename = no grant at the new address; recreating the same
//     path keeps it.
//
// Requires real Chrome (puppeteer-core); the whole suite skips without it,
// same convention as foreign-journey.

import { writeFile } from "node:fs/promises";

import { afterAll, beforeAll, describe, test } from "vitest";

import { assert, assertEq } from "../harness/check.ts";
import { docPath } from "../harness/cli.ts";
import { launchBrowser, type Browser, type Page } from "../harness/chrome.ts";
import { chromeSkipReason, sandbox, type TestHome } from "../harness/env.ts";
import { connect, docApi, type Api } from "../harness/http.ts";
import { killAllTracked } from "../harness/proc.ts";
import { startServe, type Daemon } from "../harness/serve.ts";

const skip = chromeSkipReason();

// Probe document: each isolation fact inside the opaque origin is written into
// a postMessage (the parent page only collects, never replies).
// The fetches hit relative paths — under an opaque origin they resolve to the
// daemon's own host, exactly right for testing "can the network tier touch the
// hReader API". The three fetch shapes each carry diagnostic value:
//   mode:cors (default) → the request crosses, the server 401s and sends no
//     ACAO → TypeError (the response is confiscated);
//   mode:no-cors → an opaque shell (status:0/empty body) — proves the request
//     really went over the wire;
//   CSP connect-src 'none' (network off) → TypeError (the request never left).
// The write probe uses text/plain to dodge the CORS preflight, letting the
// request really reach the server before being refused — the refusal evidence
// is that the test side then sees the grant unchanged ({scripts:false} never
// took effect).
const PROBE_HTML = `<!DOCTYPE html><html><body><script>
const out = {};
const probe = (n, f) => { try { out[n] = f(); } catch (e) { out[n] = e.name; } };
probe('cookie', () => { void document.cookie; return document.cookie; });
probe('storage', () => { void window.localStorage; return 'ok'; });
probe('parentDom', () => parent.document.title);
const emit = (m) => parent.postMessage('pp:' + m, '*');
(async () => {
  try {
    const r = await fetch('/api/permissions', { credentials: 'include' });
    emit('readCors=' + r.status + ':' + r.type);
  } catch (e) { emit('readCors=' + e.name); }
  try {
    const r = await fetch('/api/permissions', { mode: 'no-cors' });
    emit('read=' + r.status + ':' + r.type);
    try { emit('readBody=' + JSON.stringify(await r.text())); } catch (e) { emit('readBody=' + e.name); }
  } catch (e) { emit('read=' + e.name); }
  try {
    const r = await fetch('/api/doc/probe.html/permissions', {
      method: 'POST', mode: 'no-cors',
      headers: { 'content-type': 'text/plain' }, body: '{"scripts":false}',
    });
    emit('write=' + r.status + ':' + r.type);
  } catch (e) { emit('write=' + e.name); }
  emit('probes=' + JSON.stringify(out));
  setInterval(() => parent.postMessage('pp:beat', '*'), 50);
})();
</script></body></html>`;

// Adversarial document: a meta-CSP tries to loosen the policy, a <base> tries
// to rewrite the base URL, and every script vector fires at once.
// Any single one that runs emits a 'sneaky:*'; total silence is the proof that
// script-src 'none' held.
const SNEAKY_HTML = `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline' 'unsafe-eval' data: blob:">
<base href="https://evil.example/">
</head><body>
<img src="no-such.png" onerror="parent.postMessage('sneaky:onerror','*')">
<script>parent.postMessage('sneaky:inline','*')</script>
<script src="data:text/javascript,parent.postMessage('sneaky:src','*')"></script>
<a id="jx" href="javascript:parent.postMessage('sneaky:jsurl','*')">x</a>
<script>try { eval("parent.postMessage('sneaky:eval','*')"); } catch(e) {}
document.getElementById('jx').click();</script>
</body></html>`;

describe.skipIf(skip !== undefined)("permissions-journey", () => {
  let home: TestHome;
  let daemon: Daemon;
  let api: Api;
  let browser: Browser;
  let page: Page;

  const infoOf = async (docId: string) => await api.getJson(`${docApi(docId)}/info`);

  /** Collect pp:/sneaky messages on the page; must be reinstalled after navigate (the execution context is destroyed on navigation). */
  const installCollector = async (): Promise<void> => {
    await page.eval(`(() => {
      window.__pp = [];
      window.addEventListener('message', (e) => {
        if (typeof e.data === 'string' && (e.data.startsWith('pp:') || e.data.startsWith('sneaky:'))) {
          window.__pp.push(e.data);
        }
      });
      return true;
    })()`);
  };

  /**
   * Wait for the app's SSE to reach live before acting: doc.changed/
   * permissions.changed can only reach the page once the connection is up — a
   * POST sent earlier misses the event forever (an observable condition, not a
   * timing assumption).
   */
  const waitLive = async (): Promise<void> => {
    const live = await page.wait(
      `(() => { const el = document.querySelector('#hr-conn'); return el && el.getAttribute('data-conn') === 'live'; })()`,
      20_000,
    );
    assert(live === true, "the app's SSE never reached live");
  };

  const msgs = async (): Promise<string[]> => {
    const value = await page.eval(`Array.isArray(window.__pp) ? window.__pp : []`);
    return Array.isArray(value) ? (value as string[]) : [];
  };

  /** Wait until a message starting with prefix appears in the collector; returns that message or undefined. */
  const waitMsg = async (prefix: string, timeoutMs = 20_000): Promise<string | undefined> => {
    const hit = await page.wait(
      `window.__pp && window.__pp.some((m) => m.startsWith(${JSON.stringify(prefix)}))`,
      timeoutMs,
    );
    if (hit !== true) return undefined;
    return (await msgs()).find((m) => m.startsWith(prefix));
  };

  beforeAll(async () => {
    home = sandbox("perms");
    await writeFile(docPath(home.ws, "probe.html"), PROBE_HTML, "utf8");
    await writeFile(docPath(home.ws, "sneaky.html"), SNEAKY_HTML, "utf8");
    daemon = await startServe({ file: "probe.html", workspace: home.ws, home: home.home });
    api = await connect(daemon.port, daemon.token);
    browser = await launchBrowser();
    page = await browser.open(daemon.url);
    await installCollector();
    await waitLive();
  });

  afterAll(async () => {
    await browser.close();
    await daemon.stop();
    await killAllTracked();
    home.cleanup();
  });

  test("should block every sandbox escape when scripts are on and network is off, and confiscate connect-src 'self' crossings at the credential gate", async () => {
    const grant = await api.post(`${docApi("probe.html")}/permissions`, { scripts: true });
    assertEq(grant.status, 200, "scripts grant POST status code");
    const info = await infoOf("probe.html");
    assertEq(info["trust"], "local", "scripts on → trust compat field");
    const sandboxAttr = await page.wait(
      `(() => { const f = document.querySelector('#hr-foreign-frame'); return f && f.getAttribute('sandbox') === 'allow-scripts' && 'ok'; })()`,
    );
    assertEq(sandboxAttr, "ok", "sandbox after scripts on");

    const probes = await waitMsg("pp:probes=");
    assert(probes !== undefined, "the probe results never came back (the script did not run)");
    for (const key of ["cookie", "storage", "parentDom"]) {
      assert(
        probes.includes(`"${key}":"SecurityError"`),
        `${key} was not blocked by the opaque origin: ${probes}`,
      );
    }
    // Network off: connect-src 'self' lets same-directory resources through,
    // but fetches to the API routes are still 401/403-rejected server-side —
    // no-cors gets an opaque shell with an empty body; cors gets no ACAO →
    // TypeError.
    const read = await waitMsg("pp:read=");
    assert(
      read === "pp:read=0:opaque",
      `no-cors fetch should get an opaque shell (the request really crossed, no credentials in the packet), got ${String(read)}`,
    );
    const readCors = await waitMsg("pp:readCors=");
    assert(
      readCors === "pp:readCors=TypeError",
      `cors fetch should have its response confiscated by CORS (no ACAO), got ${String(readCors)}`,
    );
  });

  test("should confiscate responses and keep the grant unchanged when requests cross with network on but no credentials in the packet", async () => {
    const grant = await api.post(`${docApi("probe.html")}/permissions`, { network: true });
    assertEq(grant.status, 200, "network grant POST status code");
    // The combination changed → the widget reloads the iframe → the probe
    // reruns and a fresh round of messages arrives.
    // no-cors read: an opaque shell — the request really went over the wire,
    // but status/body stay unreadable to the page.
    const read = await waitMsg("pp:read=0:opaque");
    assert(
      read !== undefined,
      `no-cors fetch should get an opaque shell with network on (got ${JSON.stringify(await msgs())})`,
    );
    const body = await waitMsg("pp:readBody=");
    assert(body !== undefined, "readBody message missing");
    assert(
      body === 'pp:readBody=""',
      `credential isolation: the opaque response body should be an empty string, got ${body}`,
    );
    // Default cors read: the server already 401-rejected (no hr cookie) and
    // sends no ACAO → confiscated as a TypeError.
    const readCors = await waitMsg("pp:readCors=", 5_000);
    assert(
      readCors === "pp:readCors=TypeError",
      `default-mode fetch should have its response confiscated by CORS, got ${String(readCors)}`,
    );
    const write = await waitMsg("pp:write=0:opaque");
    assert(
      write !== undefined,
      `the write request should get an opaque shell (got ${JSON.stringify(await msgs())})`,
    );
    // The server-side veto evidence: that POST inside the iframe tried to turn
    // scripts off — the grant must stay exactly as it was.
    const info = await infoOf("probe.html");
    const perms = info["permissions"] as Record<string, unknown> | undefined;
    assertEq(
      perms?.["scripts"],
      true,
      "the scripts grant must still stand after the forged write request inside the iframe",
    );
    assertEq(perms?.["network"], true, "the network grant should still be on");

    // Second proof that credentials never go over the wire (properties of the
    // cookie itself, unrelated to the iframe):
    // HttpOnly → JS can't read it; SameSite=Strict → never sent on cross-site
    // requests (every request from an opaque origin is cross-site).
    const boot = await fetch(
      `http://127.0.0.1:${String(daemon.port)}/?token=${encodeURIComponent(daemon.token)}`,
      { redirect: "manual" },
    );
    const setCookie = boot.headers.get("set-cookie") ?? "";
    assert(setCookie.includes("HttpOnly"), `session cookie missing HttpOnly: ${setCookie}`);
    assert(
      setCookie.includes("SameSite=Strict"),
      `session cookie missing SameSite=Strict: ${setCookie}`,
    );
  });

  test("should keep meta-CSP overrides, base hijacks and every script vector silent when scripts are off and network is on", async () => {
    // Grant first, then read headers: the page CSP follows the grant; the other
    // order gets the default all-off tier.
    const grant = await api.post(`${docApi("sneaky.html")}/permissions`, { network: true });
    assertEq(grant.status, 200, "sneaky network grant POST status code");
    // `/s/` now only issues the 302 entry: the CSP lands on the `/f/<cap>/`
    // page response, so follow it there.
    // api.get uses fetch's default follow — seeing the 302 itself requires
    // redirect:"manual".
    const entry = await fetch(
      `http://127.0.0.1:${String(daemon.port)}/s/${encodeURIComponent("sneaky.html")}`,
      { redirect: "manual", headers: { cookie: api.cookie } },
    );
    const location = entry.headers.get("location") ?? "";
    assert(location.startsWith("/f/"), `sneaky /s/ should 302 to /f/, got ${String(entry.status)}`);
    const res = await api.get(location);
    const csp = res.headers.get("content-security-policy") ?? "";
    assert(csp.includes("script-src 'none'"), `scripts-off CSP should ban scripts: ${csp}`);
    assert(
      csp.includes("img-src 'self' http: https:"),
      `network-on CSP should allow images: ${csp}`,
    );
    assert(
      csp.includes("sandbox") && !csp.includes("allow-scripts"),
      "sandbox should not carry scripts",
    );

    await page.navigate(
      `http://127.0.0.1:${String(daemon.port)}/?doc=${encodeURIComponent("sneaky.html")}`,
    );
    await installCollector();
    const loaded = await page.wait(
      `(() => { const f = document.querySelector('#hr-foreign-frame'); return f && !f.hidden && f.getAttribute('sandbox') === ''; })()`,
      20_000,
    );
    assert(loaded === true, "the sneaky iframe did not appear under the scripts-off tier");

    // Window of silence: no sneaky:* vector (inline/onerror/src/eval/
    // javascript:) may arrive.
    await new Promise((resolve) => setTimeout(resolve, 1600));
    const leaks = (await msgs()).filter((m) => m.startsWith("sneaky:"));
    assertEq(leaks.length, 0, `script vectors still escaped under scripts-off: ${leaks.join(",")}`);
  });

  test("should broadcast permissions.changed and grey out the bottom-bar switches when global modes take over", async () => {
    await page.navigate(
      `http://127.0.0.1:${String(daemon.port)}/?doc=${encodeURIComponent("probe.html")}`,
    );
    await installCollector();
    await waitLive();
    const sse = await api.openSse();
    try {
      const modes = await api.post("/api/permissions", { scripts: "deny" });
      assertEq(modes.status, 200, "global scripts=deny POST status code");
      const event = await sse.next("permissions.changed", 15_000);
      assert(event !== undefined, "the permissions.changed event was never pushed");

      const greyed = await page.wait(
        `(() => { const b = document.querySelector('#hr-perm-scripts'); return b && b.disabled && 'ok'; })()`,
        15_000,
      );
      assertEq(greyed, "ok", "the bottom-bar switch did not grey out under global deny");
      const title = await page.eval(
        `(() => { const b = document.querySelector('#hr-perm-scripts'); return b ? b.title : ''; })()`,
      );
      assert(
        typeof title === "string" && title.includes("设置"),
        `the greyed-out switch should hint "centrally controlled by settings": ${String(title)}`,
      );
      const info = await infoOf("probe.html");
      const perms = info["permissions"] as Record<string, unknown> | undefined;
      assertEq(perms?.["scripts"], false, "global deny overrides the document grant");
      assertEq(perms?.["scriptsSource"], "global", "scripts source should be global");

      // Switch back to per-doc: the original grant takes effect again, the
      // switch comes back to life.
      const back = await api.post("/api/permissions", { scripts: "per-doc" });
      assertEq(back.status, 200, "switch back to per-doc status code");
      const enabled = await page.wait(
        `(() => { const b = document.querySelector('#hr-perm-scripts'); return b && !b.disabled && 'ok'; })()`,
        15_000,
      );
      assertEq(enabled, "ok", "the switch did not recover after switching back to per-doc");
      const info2 = await infoOf("probe.html");
      const perms2 = info2["permissions"] as Record<string, unknown> | undefined;
      assertEq(
        perms2?.["scripts"],
        true,
        "the document grant takes effect again after per-doc is restored",
      );
      assertEq(perms2?.["scriptsSource"], "doc", "scripts source should return to doc");
    } finally {
      sse.close();
    }
  });
});
