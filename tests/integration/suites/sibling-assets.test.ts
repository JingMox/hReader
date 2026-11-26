// Journey: a multi-file foreign page served through /f/ in real Chrome, under
// all four script x network permission combos. The page lives in `page/` as
// index.html + style.css + img.png + app.js + data.json + font.woff2 and is
// navigated top-level at its /f/<cap>/ URL — no cookie, the cap is the whole
// credential. Asserted per combo:
//   - style.css and img.png always load; the @font-face registers and the
//     font resource is servable in every combo (local resources are not
//     subject to the network switch);
//   - app.js only ever runs when scripts are on (execution globals are the
//     evidence — CSP-blocked subresource *attempts* still show up in resource
//     timing, so entries alone cannot distinguish fetch from execution);
//   - the page's fetch of data.json succeeds only when scripts are on;
//   - the external http: beacon img only ever reaches the ext site when
//     network is on (server-side hit count is the ground truth);
//   - the ../ escape fails (in-page status >= 400, plus an HTTP-layer 404 on
//     the encoded traversal spelling);
//   - window.origin is always "null" (the CSP sandbox applies top-level too).

import { createServer, type Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";

import { afterAll, beforeAll, describe, test } from "vitest";

import { assert, assertEq } from "../harness/check.ts";
import { docPath } from "../harness/cli.ts";
import { launchBrowser, type Browser, type Page } from "../harness/chrome.ts";
import { chromeSkipReason, sandbox, until, type TestHome } from "../harness/env.ts";
import { connect, docApi, type Api } from "../harness/http.ts";
import { killAllTracked } from "../harness/proc.ts";
import { startServe, type Daemon } from "../harness/serve.ts";

const skip = chromeSkipReason();

const DOC = "page/index.html";

/** Valid 1x1 transparent PNG — img naturalWidth assertions need real bytes. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG = Buffer.from(PNG_B64, "base64");

const SECRET = "TOP-SECRET-CANARY\n";

interface ExtSite {
  readonly url: string;
  readonly hits: string[];
  readonly close: () => Promise<void>;
}

/** A real second origin on a different port: the network-switch canary. */
const startExtSite = async (): Promise<ExtSite> => {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(String(req.url));
    res.writeHead(200, { "content-type": "image/png" });
    res.end(PNG);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    hits,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
};

/** `{{EXT}}` is substituted with the ext-site origin once its port is known. */
const PAGE_HTML = `<!DOCTYPE html><html><head>
<link rel="stylesheet" href="style.css">
</head><body>
<p id="hero">styled</p>
<img id="pic" src="img.png" alt="x">
<img id="beacon" src="{{EXT}}/beacon.png" alt="">
<script src="app.js"></script>
</body></html>`;

const PAGE_CSS = `@font-face { font-family: ProbeFont; src: url('font.woff2'); }
body { font-family: ProbeFont, serif; }
#hero { color: rgb(255, 0, 0); }`;

/** app.js writes only globals — scripts-off detection = globals absent. */
const APP_JS = `window.__probe = true;
(async () => {
  try { const r = await fetch('data.json'); window.__jsonStatus = r.status; }
  catch (e) { window.__jsonStatus = String(e); }
  try { const r = await fetch('font.woff2'); window.__fontStatus = r.status; }
  catch (e) { window.__fontStatus = String(e); }
  try { const r = await fetch('other.html'); window.__sibStatus = r.status; }
  catch (e) { window.__sibStatus = String(e); }
  try { const r = await fetch('../secret.txt'); window.__esc = r.status; }
  catch (e) { window.__esc = String(e); }
})();`;

interface Combo {
  readonly name: string;
  readonly scripts: boolean;
  readonly network: boolean;
}

const COMBOS: readonly Combo[] = [
  { name: "scripts-off+network-off", scripts: false, network: false },
  { name: "scripts-off+network-on", scripts: false, network: true },
  { name: "scripts-on+network-off", scripts: true, network: false },
  { name: "scripts-on+network-on", scripts: true, network: true },
];

describe.skipIf(skip !== undefined)("sibling-assets", () => {
  let home: TestHome;
  let daemon: Daemon;
  let api: Api;
  let browser: Browser;
  let ext: ExtSite;
  let frameUrl = "";
  let cap = "";

  const baseUrl = (): string => `http://127.0.0.1:${String(daemon.port)}`;

  /** `/s/` is a 302 entry now: take the cap frame URL from its location. */
  const resolveFrameUrl = async (): Promise<void> => {
    const entry = await fetch(`${baseUrl()}/s/${encodeURIComponent(DOC)}`, {
      redirect: "manual",
      headers: { cookie: api.cookie },
    });
    assertEq(entry.status, 302, "/s/<docId> status");
    const location = entry.headers.get("location") ?? "";
    assert(location.startsWith("/f/"), `/s/ should redirect into /f/, got ${location}`);
    frameUrl = location;
    cap = location.split("/")[2] ?? "";
  };

  const grant = async (combo: Combo): Promise<void> => {
    const res = await api.post(`${docApi(DOC)}/permissions`, {
      scripts: combo.scripts,
      network: combo.network,
    });
    assertEq(res.status, 200, `grant ${combo.name}`);
  };

  const openPage = async (): Promise<Page> => await browser.open(`${baseUrl()}${frameUrl}`);

  /** Local resources (style/img/font) must load in every combo. */
  const assertLocalAssets = async (page: Page): Promise<void> => {
    assertEq(await page.eval("window.origin"), "null", "window.origin");
    const styled = await page.wait(
      `getComputedStyle(document.getElementById('hero')).color === 'rgb(255, 0, 0)'`,
    );
    assert(styled === true, "style.css did not apply");
    const img = await page.wait(
      `(() => { const el = document.getElementById('pic'); return el && el.complete && el.naturalWidth > 0; })()`,
    );
    assert(img === true, "img.png did not decode");
    // Fonts: resource timing does not surface @font-face fetches inside a
    // CSP-sandboxed document, so the scripts-off signal is the FontFaceSet —
    // the @font-face rule registered (CSS machinery works). Whether the fetch
    // is permitted is asserted where it is observable: the page's own
    // fetch('font.woff2') in scripts-on combos, and the dedicated HTTP-layer
    // case for the Origin:null CORS request in every combo.
    const fontRegistered = await page.wait(
      `document.fonts.size >= 1 && document.fonts.status === 'loaded'`,
    );
    assert(fontRegistered === true, "ProbeFont @font-face never settled");
  };

  /** External beacon: allowed only by the network switch, observed on the ext site. */
  const assertExt = async (before: number, allowed: boolean): Promise<void> => {
    if (allowed) {
      const count = await until(
        () => ext.hits.length,
        (n) => n > before,
        { timeoutMs: 10_000 },
      );
      assert(count > before, "beacon never reached the ext site while network is on");
      return;
    }
    // The negative case needs a positive settle proxy, not a wall-clock wait:
    // by the time local resources have all completed, a CSP-permitted beacon
    // would already have fired. None did → it was blocked before dispatch.
    assertEq(ext.hits.length - before, 0, "beacon fired while network is off");
  };

  beforeAll(async () => {
    ext = await startExtSite();
    home = sandbox("assets");
    const page = docPath(home.ws, "page");
    await mkdir(page, { recursive: true });
    await writeFile(docPath(page, "index.html"), PAGE_HTML.replaceAll("{{EXT}}", ext.url), "utf8");
    await writeFile(docPath(page, "style.css"), PAGE_CSS, "utf8");
    await writeFile(docPath(page, "app.js"), APP_JS, "utf8");
    await writeFile(docPath(page, "data.json"), '{"ok":true}\n', "utf8");
    await writeFile(docPath(page, "img.png"), PNG);
    // Not a parseable font on purpose: the governed boundary is the fetch.
    await writeFile(docPath(page, "font.woff2"), Buffer.from("wOF2fake-font-bytes"));
    // A second HTML in the same directory: opened below (registering it),
    // yet still unservable to page A — caps are per-document.
    await writeFile(docPath(page, "other.html"), "<!doctype html><p>other</p>", "utf8");
    // Traversal canary: one directory up from the granted dir.
    await writeFile(docPath(home.ws, "secret.txt"), SECRET, "utf8");
    daemon = await startServe({ file: DOC, workspace: home.ws, home: home.home });
    api = await connect(daemon.port, daemon.token);
    browser = await launchBrowser();
    await resolveFrameUrl();
    // Open the sibling document too: under a per-directory cap this would
    // silently grant page A read access to it.
    const otherEntry = await fetch(`${baseUrl()}/s/${encodeURIComponent("page/other.html")}`, {
      redirect: "manual",
      headers: { cookie: api.cookie },
    });
    assertEq(otherEntry.status, 302, "sibling /s/ entry");
  });

  afterAll(async () => {
    await browser.close();
    await daemon.stop();
    await ext.close();
    await killAllTracked();
    home.cleanup();
  });

  test("should 404 the encoded traversal spelling at the HTTP layer", async () => {
    // fetch() normalizes literal `..` client-side; the encoded spelling is the
    // honest way to reach the server's verdict from here.
    const res = await fetch(`${baseUrl()}/f/${cap}/%2e%2e/secret.txt`);
    assertEq(res.status, 404, "encoded ../secret.txt");
    assertEq(await res.text(), '{"code":"not_found"}', "traversal body");
  });

  test("should serve the font over the CORS-mode fetch the sandbox sends", async () => {
    // The @font-face request is exactly the motivating case for this route:
    // a CORS-mode subresource fetch carrying `Origin: null`. It must get a
    // typed body back with the literal `null` ACAO stamp.
    const res = await fetch(`${baseUrl()}/f/${cap}/font.woff2`, {
      headers: { origin: "null" },
    });
    assertEq(res.status, 200, "font.woff2 status");
    assertEq(res.headers.get("content-type"), "font/woff2", "font content-type");
    assertEq(res.headers.get("access-control-allow-origin"), "null", "font ACAO");
    assertEq(res.headers.get("x-content-type-options"), "nosniff", "font nosniff");
  });

  for (const combo of COMBOS) {
    test(`should honor local assets and the ${combo.name} combo in real Chrome`, async () => {
      await grant(combo);
      const hitsBefore = ext.hits.length;
      const page = await openPage();
      await assertLocalAssets(page);

      const probe = await page.eval("window.__probe");
      if (!combo.scripts) {
        // script-src 'none' + bare sandbox: nothing in the page may have run.
        assert(probe === undefined, "app.js ran while scripts are off");
        assertEq(await page.eval("window.__jsonStatus"), undefined, "json fetch ran");
        assertEq(await page.eval("window.__esc"), undefined, "escape fetch ran");
      } else {
        assert((await page.wait("window.__probe === true")) === true, "app.js did not run");
        const jsonStatus = await page.wait(
          `typeof window.__jsonStatus === 'number' ? window.__jsonStatus : false`,
        );
        assertEq(jsonStatus, 200, "fetch data.json");
        const fontStatus = await page.wait(
          `typeof window.__fontStatus === 'number' ? window.__fontStatus : false`,
        );
        assertEq(fontStatus, 200, "fetch font.woff2");
        // The sibling document in page/ was opened via /s/ — but its HTML
        // must stay unreadable to page A: caps are per-document, so
        // 'other.html' under A's cap is a non-whitelist 404 (or a TypeError).
        const sibSettled = await page.wait(`typeof window.__sibStatus !== 'undefined'`);
        assert(sibSettled === true, "sibling fetch never settled");
        const sib = await page.eval("window.__sibStatus");
        assert(
          (typeof sib === "string" && sib.startsWith("TypeError")) ||
            (typeof sib === "number" && sib >= 400),
          `sibling document was not refused: ${String(sib)}`,
        );
        // '../secret.txt' normalizes to /f/secret.txt — a 2-segment path off
        // the capability route, where Origin:null is rejected 403 and the
        // response carries no ACAO. A CORS-mode fetch therefore sees either a
        // numeric refusal or a TypeError confiscation; both mean "not served".
        const settled = await page.wait(`typeof window.__esc !== 'undefined'`);
        assert(settled === true, "escape fetch never settled");
        const esc = await page.eval("window.__esc");
        assert(
          (typeof esc === "string" && esc.startsWith("TypeError")) ||
            (typeof esc === "number" && esc >= 400),
          `../ escape was not refused: ${String(esc)}`,
        );
      }
      await assertExt(hitsBefore, combo.network);
    });
  }
});
