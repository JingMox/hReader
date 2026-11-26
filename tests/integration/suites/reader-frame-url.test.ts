// Multi-file foreign page inside the reader shell, in real Chrome: the iframe
// must point at the `/f/<cap>/` frame URL reported by `/info` — no `/s/`
// redirect hop — and the page's sibling assets must load through the same
// capability. Evidence:
//   - #hr-foreign-frame's src attribute equals info.frameUrl verbatim;
//   - style.css applied and img.png decoded inside the sandboxed frame, as
//     reported by the page's own probe script over postMessage (the only
//     channel out of an opaque-origin frame);
//   - exactly one iframe load event for the first navigation — the direct
//     /f/ load keeps the mount credit ledger honest (no hidden second load
//     that the D2 reset would have answered with a blocked banner);
//   - after a doc.changed reload the src stays on /f/ with the ?r= tag and
//     the assets keep loading.

import { mkdir, writeFile } from "node:fs/promises";

import { afterAll, beforeAll, describe, test } from "vitest";

import { assert, assertEq } from "../harness/check.ts";
import { docPath } from "../harness/cli.ts";
import { launchBrowser, type Browser, type Page } from "../harness/chrome.ts";
import { chromeSkipReason, sandbox, type TestHome } from "../harness/env.ts";
import { connect, docApi, type Api } from "../harness/http.ts";
import { killAllTracked } from "../harness/proc.ts";
import { startServe, type Daemon } from "../harness/serve.ts";

const skip = chromeSkipReason();

const DOC = "page/index.html";

/** Valid 1x1 transparent PNG — img naturalWidth assertions need real bytes. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG = Buffer.from(PNG_B64, "base64");

const PAGE_HTML = (marker: string) => `<!DOCTYPE html><html><head>
<link rel="stylesheet" href="style.css">
</head><body>
<p id="hero">${marker}</p>
<img id="pic" src="img.png" alt="x">
<script src="probe.js"></script>
</body></html>`;

const PAGE_CSS = `#hero { color: rgb(255, 0, 0); }`;

// Repeating probe: a one-shot post could outrun the parent's listener install;
// a heartbeat cannot. The payload carries the only observable evidence of
// asset loading inside an opaque-origin frame.
const PROBE_JS = `setInterval(() => {
  const hero = document.getElementById('hero');
  const pic = document.getElementById('pic');
  if (!hero || !pic) return;
  parent.postMessage('frame-probe:' + JSON.stringify({
    color: getComputedStyle(hero).color,
    img: pic.complete && pic.naturalWidth > 0,
    marker: hero.textContent,
  }), '*');
}, 40);`;

// Init-script collector: runs before any page or iframe script on every new
// document, so the probe listener and the iframe load counter can never miss.
// The counter only counts loads that carry a src attribute: the parser-inserted
// iframe also fires one load for its initial about:blank (src still unset) —
// that commit precedes the app's own listener and is not a navigation.
const COLLECTOR = `(() => {
  window.__probes = [];
  window.__loads = 0;
  window.addEventListener('message', (e) => {
    if (typeof e.data === 'string' && e.data.startsWith('frame-probe:')) {
      window.__probes.push(JSON.parse(e.data.slice('frame-probe:'.length)));
    }
  });
  const attach = () => {
    const f = document.querySelector('#hr-foreign-frame');
    if (f && !f.__hrLc) {
      f.__hrLc = true;
      f.addEventListener('load', () => {
        if (f.getAttribute('src') !== null) window.__loads += 1;
      });
    }
  };
  new MutationObserver(attach).observe(document, { childList: true, subtree: true });
  attach();
})()`;

describe.skipIf(skip !== undefined)("reader-frame-url", () => {
  let home: TestHome;
  let daemon: Daemon;
  let api: Api;
  let browser: Browser;
  let page: Page;

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

  const loadCount = async (): Promise<number> => {
    const value = await page.eval(`typeof window.__loads === 'number' ? window.__loads : -1`);
    return typeof value === "number" ? value : -1;
  };

  /** Wait until a probe heartbeat reports both assets loaded inside the frame. */
  const waitAssets = async (marker: string): Promise<void> => {
    const settled = await page.wait(
      `Array.isArray(window.__probes) && window.__probes.some((p) =>
        p && p.marker === ${JSON.stringify(marker)} && p.color === 'rgb(255, 0, 0)' && p.img === true)`,
      20_000,
    );
    assert(settled === true, "frame probe never reported css+img loaded");
  };

  beforeAll(async () => {
    home = sandbox("frameurl");
    const dir = docPath(home.ws, "page");
    await mkdir(dir, { recursive: true });
    await writeFile(docPath(dir, "index.html"), PAGE_HTML("first"), "utf8");
    await writeFile(docPath(dir, "style.css"), PAGE_CSS, "utf8");
    await writeFile(docPath(dir, "img.png"), PNG);
    await writeFile(docPath(dir, "probe.js"), PROBE_JS, "utf8");
    daemon = await startServe({ file: DOC, workspace: home.ws, home: home.home });
    api = await connect(daemon.port, daemon.token);
    // Grant scripts before the reader mounts: probe.js is the only way to
    // observe asset loading inside the sandboxed frame.
    const grant = await api.post(`${docApi(DOC)}/permissions`, { scripts: true });
    assertEq(grant.status, 200, "grant scripts");
    browser = await launchBrowser();
    page = await browser.open(daemon.url);
    await page.onNewDocument(COLLECTOR);
    await page.navigate(daemon.url);
    const mounted = await page.wait(
      `(() => { const f = document.querySelector('#hr-foreign-frame'); return Boolean(f && !f.hidden && f.getAttribute('src')); })()`,
      20_000,
    );
    assert(mounted === true, "foreign iframe did not mount");
  });

  afterAll(async () => {
    await browser.close();
    await daemon.stop();
    await killAllTracked();
    home.cleanup();
  });

  test("should mount the iframe at the /f/ frame URL reported by info", async () => {
    const info = await api.getJson(`${docApi(DOC)}/info`);
    const frameUrl = info["frameUrl"];
    assert(
      typeof frameUrl === "string" && frameUrl.startsWith("/f/"),
      `info.frameUrl is not an /f/ URL: ${JSON.stringify(frameUrl)}`,
    );
    assertEq(await frameSrc(), frameUrl, "iframe src should equal info.frameUrl");
    const sandboxAttr = await page.eval(
      `(() => { const f = document.querySelector('#hr-foreign-frame'); return f ? f.getAttribute('sandbox') : 'no-frame'; })()`,
    );
    assertEq(sandboxAttr, "allow-scripts", "sandbox for the granted scripts dimension");
  });

  test("should load sibling css and image through the same capability", async () => {
    await waitAssets("first");
  });

  test("should fire exactly one load for the first navigation with no blocked banner", async () => {
    await waitAssets("first");
    assertEq(
      await loadCount(),
      1,
      "direct /f/ load must produce exactly one src-bearing load event",
    );
    assertEq(await errorText(), "", "no blocked banner for our own mount navigation");
  });

  test("should keep loading through /f/ after a doc.changed reload", async () => {
    await writeFile(docPath(home.ws, DOC), PAGE_HTML("second"), "utf8");
    const reloaded = await page.wait(
      `(() => { const f = document.querySelector('#hr-foreign-frame');
        const src = f && f.getAttribute('src');
        return typeof src === 'string' && src.startsWith('/f/') && src.includes('?r='); })()`,
      20_000,
    );
    assert(reloaded === true, `frame did not reload on /f/ with a ?r= tag: ${await frameSrc()}`);
    // The reloaded document beats with the new marker — proof the /f/ URL
    // (not a stale cap) served the updated page and its assets.
    await waitAssets("second");
    const settled = await page.wait(`window.__loads >= 2`, 20_000);
    assert(settled === true, "reload load event never arrived");
  });
});
