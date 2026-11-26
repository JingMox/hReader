// D2 adversarial journey: a foreign document tries to navigate its own iframe
// out of the reader via meta refresh, target=_self links, and location=.
// Facts established against real Chrome and pinned here one by one:
//   - Cross-origin self-navigation never leaves: the reader shell's own
//     `frame-src 'self'` CSP vetoes it pre-commit. The iframe lands on
//     chrome-error (no load event, zero external hits) — existing defense,
//     not part of this fix.
//   - Same-origin self-navigation commits, but the opaque-origin initiator
//     gets no session cookie (SameSite=Strict), so it lands on a 401 dead
//     page. With network off, the app's load-credit gate resets src and
//     shows a banner; with network on it lets the nav through.
//   - With scripts off, Chrome never fires meta refresh at all.
//   - A parse-time location= (executed during the initial parse) supersedes
//     the initial pending load and consumes the mount credit — a one-hop
//     blind spot, but it can only land on a credentialless 401 dead page;
//     the evidence test pins it as observable-but-harmless.
// `nav-target.html` is the beacon: it postMessages 'landed' only when it
// truly runs; the 401 dead page can never send it.
// Requires real Chrome (puppeteer-core); the whole suite skips without it,
// same convention as permissions-journey.

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

const BLOCKED_COPY = "已阻止";

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
    res.end("<title>exfil</title><p>escaped</p>");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(typeof address === "object" && address !== null, "external test site failed to start");
  return { hits, server, port: address.port };
};

describe.skipIf(skip !== undefined)("foreign-nav-guard", () => {
  let home: TestHome;
  let daemon: Daemon;
  let api: Api;
  let browser: Browser;
  let page: Page;
  let ext: HitLog;

  const urlOf = (docId: string): string =>
    `http://127.0.0.1:${String(daemon.port)}/?doc=${encodeURIComponent(docId)}`;

  const writeDoc = async (name: string, template: string): Promise<void> => {
    await writeFile(
      docPath(home.ws, name),
      template.replaceAll("{{EXT}}", `http://127.0.0.1:${String(ext.port)}`),
      "utf8",
    );
  };

  const grant = async (docId: string, patch: Record<string, boolean>): Promise<void> => {
    const res = await api.post(`${docApi(docId)}/permissions`, patch);
    assertEq(res.status, 200, `granting ${docId} ${JSON.stringify(patch)} status`);
  };

  /** Wait until the foreign shell mounted: the iframe exists, visible, with src. */
  const waitFrame = async (): Promise<void> => {
    const ok = await page.wait(
      `(() => { const f = document.querySelector('#hr-foreign-frame'); return Boolean(f && !f.hidden && f.getAttribute('src')); })()`,
      20_000,
    );
    assert(ok === true, "foreign iframe did not mount");
  };

  /** Wait for the banner's blocked copy: evidence the reset fired with network off. */
  const waitBlocked = async (): Promise<void> => {
    const ok = await page.wait(
      `(() => { const el = document.querySelector('#hr-foreign-error'); return Boolean(el && el.textContent.includes(${JSON.stringify(BLOCKED_COPY)})); })()`,
      20_000,
    );
    assert(ok === true, "blocked banner did not appear after self-navigation");
  };

  const frameSrc = async (): Promise<string> => {
    const src = await page.eval(
      `(() => { const f = document.querySelector('#hr-foreign-frame'); return f ? f.getAttribute('src') : ''; })()`,
    );
    return typeof src === "string" ? src : "";
  };

  const errorText = async (): Promise<string> => {
    const err = await page.eval(
      `(() => { const el = document.querySelector('#hr-foreign-error'); return el ? el.textContent : ''; })()`,
    );
    return typeof err === "string" ? err : "";
  };

  /**
   * Beacon/probe collectors and the iframe load counter, installed as an
   * init script: it runs before any page or iframe script on every new
   * document, so parse-time postMessages and early load events can never
   * outrun the listeners (a post-navigate eval can, under load).
   */
  const COLLECTOR_SOURCE = `(() => {
    window.__pp = [];
    window.__loads = 0;
    window.addEventListener('message', (e) => {
      if (e.data === 'landed' || (typeof e.data === 'string' && e.data.startsWith('probe:'))) {
        window.__pp.push(e.data);
      }
    });
    const attach = () => {
      const f = document.querySelector('#hr-foreign-frame');
      if (f && !f.__hrLc) {
        f.__hrLc = true;
        f.addEventListener('load', () => { window.__loads += 1; });
      }
    };
    new MutationObserver(attach).observe(document, { childList: true, subtree: true });
    attach();
  })()`;

  const msgs = async (): Promise<string[]> => {
    const value = await page.eval(`Array.isArray(window.__pp) ? window.__pp : []`);
    return Array.isArray(value) ? (value as string[]) : [];
  };

  const loadCount = async (): Promise<number> => {
    const value = await page.eval(`typeof window.__loads === 'number' ? window.__loads : -1`);
    return typeof value === "number" ? value : -1;
  };

  const waitMsg = async (prefix: string): Promise<void> => {
    const hit = await page.wait(
      `Array.isArray(window.__pp) && window.__pp.some((m) => m.startsWith(${JSON.stringify(prefix)}))`,
      20_000,
    );
    assert(hit === true, `expected page message never arrived: ${prefix}`);
  };

  beforeAll(async () => {
    home = sandbox("navguard");
    ext = await startExtSite();
    // Beacon: replies only when it truly runs. Granted scripts across the suite.
    await writeDoc(
      "nav-target.html",
      `<!DOCTYPE html><html><body><script>parent.postMessage('landed','*')</script></body></html>`,
    );
    // Meta refresh to same origin: a self-nav scheduled only after the first load.
    await writeDoc(
      "nav-meta.html",
      `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0; url=/s/nav-target.html"></head><body>meta</body></html>`,
    );
    // Meta refresh cross-origin: proves the shell's frame-src 'self' vetoes first.
    await writeDoc(
      "nav-meta-xo.html",
      `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0; url={{EXT}}/meta"></head><body>meta</body></html>`,
    );
    // Meta refresh same-origin with scripts OFF: Chrome suppresses refresh there.
    await writeDoc(
      "nav-meta-so.html",
      `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0; url=/s/nav-target.html"></head><body>meta</body></html>`,
    );
    // target=_self link clicked after load: a post-load self-nav the credit gate sees.
    await writeDoc(
      "nav-self.html",
      `<!DOCTYPE html><html><body><a id="x" target="_self" href="/s/nav-target.html">x</a><script>addEventListener('load', () => setTimeout(() => document.getElementById('x').click(), 50));</script></body></html>`,
    );
    // location= triggered after load: same story.
    await writeDoc(
      "nav-loc.html",
      `<!DOCTYPE html><html><body><script>addEventListener('load', () => setTimeout(() => { location.href = '/s/nav-target.html'; }, 50));</script></body></html>`,
    );
    // Blind-spot evidence: location= executed during the initial parse supersedes
    // the still-pending initial load.
    await writeDoc(
      "nav-loc-early.html",
      `<!DOCTYPE html><html><body><script>parent.postMessage('probe:ran','*'); location.href = '/s/nav-target.html'; parent.postMessage('probe:assigned','*');</script></body></html>`,
    );
    daemon = await startServe({ file: "nav-meta.html", workspace: home.ws, home: home.home });
    api = await connect(daemon.port, daemon.token);
    browser = await launchBrowser();
    page = await browser.open(daemon.url);
    await page.onNewDocument(COLLECTOR_SOURCE);
    // Beacon and self-nav docs need the scripts dimension to act; the network
    // dimension is set per test.
    await grant("nav-target.html", { scripts: true });
    await grant("nav-meta.html", { scripts: true });
    await grant("nav-meta-xo.html", { scripts: true });
    await grant("nav-self.html", { scripts: true });
    await grant("nav-loc.html", { scripts: true });
    await grant("nav-loc-early.html", { scripts: true });
  });

  afterAll(async () => {
    await browser.close();
    await daemon.stop();
    ext.server.close();
    await killAllTracked();
    home.cleanup();
  });

  test("should reset the frame and show a blocked banner when a meta refresh self-navigates same-origin with network off", async () => {
    await page.navigate(urlOf("nav-meta.html"));
    await waitFrame();
    await waitBlocked();
    const src = await frameSrc();
    assert(
      src.includes(`/s/${encodeURIComponent("nav-meta.html")}`),
      `src should have been reset to /s/nav-meta.html, got ${src}`,
    );
  });

  test("should reset the frame when a target=_self link self-navigates same-origin with network off", async () => {
    await page.navigate(urlOf("nav-self.html"));
    await waitFrame();
    await waitBlocked();
    const src = await frameSrc();
    assert(src.includes(`/s/${encodeURIComponent("nav-self.html")}`), `src=${src}`);
  });

  test("should reset the frame when location= self-navigates same-origin with network off", async () => {
    await page.navigate(urlOf("nav-loc.html"));
    await waitFrame();
    await waitBlocked();
    const src = await frameSrc();
    assert(src.includes(`/s/${encodeURIComponent("nav-loc.html")}`), `src=${src}`);
  });

  test("should let a same-origin self-navigation commit in-frame with network on", async () => {
    await grant("nav-meta.html", { network: true });
    await page.navigate(urlOf("nav-meta.html"));
    await waitFrame();
    // The initial /s/ load and the meta-refresh nav both hit the counter:
    // >=2 means the nav committed unblocked.
    const settled = await page.wait(`window.__loads >= 2`, 20_000);
    assert(
      settled === true,
      `self-nav did not commit with network on (loads=${String(await loadCount())})`,
    );
    assertEq(await errorText(), "", "blocked banner must not appear with network on");
    const src = await frameSrc();
    assert(
      src.includes(`/s/${encodeURIComponent("nav-meta.html")}`),
      `src must not be rewritten with network on, got ${src}`,
    );
    // The landing is a 401 dead page (opaque initiator, no session cookie):
    // the beacon can never fire.
    await new Promise((resolve) => setTimeout(resolve, 800));
    assertEq(
      (await msgs()).filter((m) => m === "landed").length,
      0,
      "self-nav landing ran the beacon script (expected a credentialless 401 page)",
    );
  });

  test("should see zero external hits when a meta refresh targets cross-origin (shell frame-src vetoes first)", async () => {
    const before = ext.hits.length;
    await page.navigate(urlOf("nav-meta-xo.html"));
    await waitFrame();
    // Give refresh + the vetoed nav a window to fire; hits staying at 0 is the proof.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assertEq(
      ext.hits.length - before,
      0,
      "a cross-origin self-nav reached the outside (shell frame-src should have vetoed)",
    );
  });

  test("should never fire a same-origin meta refresh when scripts are off", async () => {
    await page.navigate(urlOf("nav-meta-so.html"));
    await waitFrame();
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assertEq(
      (await msgs()).filter((m) => m === "landed").length,
      0,
      "meta refresh somehow loaded the beacon with scripts off",
    );
    assertEq(await errorText(), "", "no self-nav means no blocked banner");
  });

  test("should land a parse-time location= only on a credentialless dead page when it steals the mount credit", async () => {
    await page.navigate(urlOf("nav-loc-early.html"));
    await waitFrame();
    await waitMsg("probe:assigned");
    await new Promise((resolve) => setTimeout(resolve, 800));
    // Known gap: the commit that supersedes the initial load emits no second
    // load, so the credit gate counts it as ours. But the landing is a
    // credentialless 401 — the beacon cannot fire, and the shell-side src
    // attribute was never rewritten.
    assertEq(
      (await msgs()).filter((m) => m === "landed").length,
      0,
      "blind-spot landing ran the beacon (it would have needed credentials)",
    );
    const src = await frameSrc();
    assert(src.includes(`/s/${encodeURIComponent("nav-loc-early.html")}`), `src=${src}`);
  });
});
