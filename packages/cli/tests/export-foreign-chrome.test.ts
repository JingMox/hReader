// This layer runs the foreign-export gate on **real Chrome**: every effective
// permission combo (scripts × network, resolved from `<ws>/.hreader/trust.json`
// and `<home>/.hreader/permissions.json`) renders through `renderPdfOf` /
// `renderPngOf` in-process, with the request audit as the verdict log and a real
// second origin as the wire-level canary.
//
// Asserted per combo:
//   - document scripts never run — even when the doc holds a scripts grant and
//     the served CSP says allow-scripts, the script's fetch beacons stay cold
//     (the browser-level kill switch, not the CSP, is the enforcement);
//   - external requests only ever appear in the audit as `allow` when the
//     effective network permission is on. Wire hits are the negative signal
//     only: the export origin is a public-namespace name, so Chrome's Private
//     Network Access blocks public→loopback *after* interception — no local
//     server can observe an allowed request; a public one would see it (the
//     audit records the verdict either way);
//   - sibling css/png (and a subdirectory asset) render — the audit carries the
//     `serve 200` records, the artifacts carry the layout/images;
//   - `../secret.png` is unreachable — it never serves 200, it never becomes a
//     PDF image, it never produces an ext hit;
//   - `data:` images still render (the interception must `continue` them).
//
// Artifact oracles: PNG height bands (sibling css = a 4400px marker, a
// natural-size 303px sibling img, fixed 40px slots for the rest — a decoded
// img keeps its natural height, a broken one collapses to the icon); PDFs are
// scanned for `/Subtype /Image` object windows carrying the fixture's
// distinctive pixel dimensions.
//
// Skip contract: same as pdf-outline-e2e — no Chrome or HREADER_SKIP_CHROME=1
// prints SKIPPED + reason and skips (never a silent pass).

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";

import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFString } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { foreignPlanOf } from "../src/commands/export-foreign";
import { pdfCommand } from "../src/commands/pdf";
import { chromeProcessOf, type ChromeDeps } from "../src/chrome/process";
import { chromeDepsOf, renderPdfOf, renderPngOf } from "../src/chrome/session";
import { skipLineOf, skipReasonOf } from "../src/commands/print-skip";
import type { ExportRequestRecord } from "../src/chrome/types";
import { registerChild } from "../../../tests/leak-guard/registry.ts";

const SYSTEM_CHROME = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

const chromeFoundOf = (): string | undefined => {
  const override = process.env["HREADER_CHROME"];
  if (override !== undefined && override !== "") {
    return existsSync(override) ? override : undefined;
  }
  return SYSTEM_CHROME.find((path) => existsSync(path));
};

const SKIP_REASON = skipReasonOf({ ...process.env, CHROME_BIN: chromeFoundOf() ?? "" });
if (SKIP_REASON !== null) process.stdout.write(skipLineOf(SKIP_REASON));

// ---- minimal real-PNG encoder (Chrome must decode these bytes) ----

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32Of = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const chunkOf = (type: string, data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(8 + data.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32Of(out.subarray(4, 8 + data.length)));
  return out;
};

/** A solid-color w×h PNG; odd dimensions make each image fingerprintable inside the PDF. */
const pngEncode = (
  width: number,
  height: number,
  rgb: readonly [number, number, number],
): Buffer => {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // depth
  ihdr[9] = 2; // truecolor
  const raw = new Uint8Array(height * (1 + 3 * width));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + 3 * width);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) raw.set(rgb, row + 1 + 3 * x);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunkOf("IHDR", ihdr),
    chunkOf("IDAT", deflateSync(raw)),
    chunkOf("IEND", new Uint8Array()),
  ]);
};

/** Distinctive dimensions per file — PDF image-dict scans distinguish them. */
const IMG = { bytes: pngEncode(16, 303, [0x00, 0x80, 0x00]), w: 16, h: 303 };
const PIC = { bytes: pngEncode(13, 41, [0x00, 0x00, 0x80]), w: 13, h: 41 };
const DATA = { bytes: pngEncode(17, 47, [0x80, 0x80, 0x00]), w: 17, h: 47 };
const SECRET = { bytes: pngEncode(19, 241, [0x80, 0x00, 0x00]), w: 19, h: 241 };
const EXT_IMG = { bytes: pngEncode(23, 107, [0x00, 0x80, 0x80]), w: 23, h: 107 };

// ---- the ext site: a real second origin; its hit log is the wire-level canary ----

interface ExtSite {
  readonly url: string;
  readonly hits: string[];
  readonly close: () => Promise<void>;
}

const startExtSite = async (): Promise<ExtSite> => {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(String(req.url));
    res.writeHead(200, { "content-type": "image/png" });
    res.end(EXT_IMG.bytes);
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

// ---- fixture page: one of every fetch channel ----

const PAGE_HTML = `<!DOCTYPE html><html><head>
<link rel="stylesheet" href="style.css">
<script>
  fetch("{{EXT}}/beacon-inline.png");
  document.documentElement.setAttribute("data-pwned", "1");
</script>
<script src="app.js"></script>
</head><body>
<div id="marker">styled</div>
<img src="img.png">
<img class="fix" src="sub/pic.png">
<img class="fix" src="../secret.png">
<img class="fix" src="data:image/png;base64,{{DATA}}">
<img class="fix" src="{{EXT}}/beacon-img.png">
<link rel="stylesheet" href="{{EXT}}/beacon.css">
<article><h1>One</h1></article><article><h1>Two</h1></article>
</body></html>`;

const APP_JS = [
  'fetch("{{EXT}}/beacon-app.png");',
  'document.documentElement.setAttribute("data-pwned", "1");',
  'document.body.style.height = "30000px";',
].join("\n");

const STYLE_CSS =
  "#marker { height: 4400px; } img { display:block; } img.fix { width:40px; height:40px; }";

interface Sandbox {
  readonly ws: string;
  readonly home: string;
  readonly doc: string;
}

const sandboxOf = (ext: string): Sandbox => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hr-fx-chrome-")));
  const ws = join(root, "ws");
  const home = join(root, "home");
  mkdirSync(join(ws, "page", "sub"), { recursive: true });
  mkdirSync(home, { recursive: true });
  const html = PAGE_HTML.split("{{EXT}}")
    .join(ext)
    .split("{{DATA}}")
    .join(DATA.bytes.toString("base64"));
  const js = APP_JS.split("{{EXT}}").join(ext);
  const doc = join(ws, "page", "index.html");
  writeFileSync(doc, html);
  writeFileSync(join(ws, "page", "app.js"), js);
  writeFileSync(join(ws, "page", "style.css"), STYLE_CSS);
  writeFileSync(join(ws, "page", "img.png"), IMG.bytes);
  writeFileSync(join(ws, "page", "sub", "pic.png"), PIC.bytes);
  writeFileSync(join(ws, "secret.png"), SECRET.bytes);
  return { ws, home, doc };
};

const grantOf = (ws: string, grant: { scripts: boolean; network: boolean }): void => {
  mkdirSync(join(ws, ".hreader"), { recursive: true });
  writeFileSync(join(ws, ".hreader", "trust.json"), JSON.stringify({ "page/index.html": grant }));
};

/** Chrome spawn goes through leak-guard registration; the session layer reaps it deterministically on every path. */
const depsOf = (): ChromeDeps => {
  const base = chromeDepsOf({ ...process.env, HREADER_CHROME: chromeFoundOf() });
  return {
    ...base,
    spawn: (file, args, options) => {
      const child = spawn(file, [...args], options);
      registerChild(child, { group: process.platform !== "win32", tag: "chrome" });
      return chromeProcessOf(child);
    },
  };
};

const NEVER = new Promise<void>(() => undefined);

interface RenderOutcome {
  readonly audit: readonly ExportRequestRecord[];
  readonly pdf: Uint8Array;
  readonly pngBytes: Uint8Array;
  readonly pngHeight: number;
  readonly pngClipped: boolean;
}

const renderOf = async (doc: string, ws: string, home: string): Promise<RenderOutcome> => {
  const plan = await foreignPlanOf({ path: doc, workspace: ws, home });
  expect(plan, "foreignPlanOf must classify the fixture as foreign").not.toBeUndefined();
  if (plan === undefined) throw new Error("unreachable");
  const audit: ExportRequestRecord[] = [];
  const record = (r: ExportRequestRecord): void => {
    audit.push(r);
  };
  const { bytes } = await renderPdfOf({
    source: { kind: "foreign", page: plan },
    pageSize: "a4",
    outline: true,
    preferCSSPageSize: false,
    timeoutMs: 30_000,
    stop: NEVER,
    deps: depsOf(),
    audit: record,
  });
  const image = await renderPngOf({
    source: { kind: "foreign", page: plan },
    width: 800,
    scale: 1,
    maxHeight: 12_000,
    timeoutMs: 30_000,
    stop: NEVER,
    deps: depsOf(),
    audit: record,
  });
  return {
    audit,
    pdf: bytes,
    pngBytes: image.bytes,
    pngHeight: image.height,
    pngClipped: image.clipped,
  };
};

/** A leaner fixture for the navigation tests: marker css + one img prove "original document". */
const REFRESH_HTML = `<!DOCTYPE html><html><head>
<meta http-equiv="refresh" content="{{DELAY}};url={{TARGET}}">
<link rel="stylesheet" href="style.css">
</head><body>
<div id="marker">styled</div><img src="img.png">
<article><h1>One</h1></article><article><h1>Two</h1></article>
</body></html>`;

const refreshSandboxOf = (delay: string, target: string): Sandbox => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hr-fx-refresh-")));
  const ws = join(root, "ws");
  const home = join(root, "home");
  mkdirSync(join(ws, "page"), { recursive: true });
  mkdirSync(home, { recursive: true });
  const doc = join(ws, "page", "index.html");
  writeFileSync(doc, REFRESH_HTML.split("{{DELAY}}").join(delay).split("{{TARGET}}").join(target));
  writeFileSync(join(ws, "page", "style.css"), STYLE_CSS);
  writeFileSync(join(ws, "page", "img.png"), IMG.bytes);
  return { ws, home, doc };
};

/** PNG-only render — the height band is the artifact oracle in this block. */
const pngOf = async (doc: string, ws: string, home: string): Promise<RenderOutcome> => {
  const plan = await foreignPlanOf({ path: doc, workspace: ws, home });
  expect(plan, "foreignPlanOf must classify the fixture as foreign").not.toBeUndefined();
  if (plan === undefined) throw new Error("unreachable");
  const audit: ExportRequestRecord[] = [];
  const image = await renderPngOf({
    source: { kind: "foreign", page: plan },
    width: 800,
    scale: 1,
    maxHeight: 12_000,
    timeoutMs: 30_000,
    stop: NEVER,
    deps: depsOf(),
    audit: (r) => {
      audit.push(r);
    },
  });
  return {
    audit,
    pdf: new Uint8Array(),
    pngBytes: image.bytes,
    pngHeight: image.height,
    pngClipped: image.clipped,
  };
};

const isExt = (url: string): boolean => url.startsWith("http://127.0.0.1:");

/** The object dictionaries of embedded images — each is ~150 chars around `/Subtype /Image`. */
const imageDictsOf = (pdf: Uint8Array): readonly string[] => {
  const text = Buffer.from(pdf).toString("latin1");
  const dicts: string[] = [];
  for (const match of text.matchAll(/\/Subtype\s*\/Image/g)) {
    const at = match.index;
    dicts.push(text.slice(Math.max(0, at - 120), at + 320));
  }
  return dicts;
};

/** True when some embedded image dictionary carries this exact dimension pair. */
const pdfHasImage = (pdf: Uint8Array, w: number, h: number): boolean =>
  imageDictsOf(pdf).some(
    (dict) =>
      new RegExp(`\\/Width\\s*${String(w)}\\b`).test(dict) &&
      new RegExp(`\\/Height\\s*${String(h)}\\b`).test(dict),
  );

const BASELINE_HEIGHT = 4400 + IMG.h + 120; // marker + natural img + 3 fixed slots' slack

describe.skipIf(SKIP_REASON !== null)("foreign export on real Chrome", () => {
  it("denied scripts + denied network: only the /f/ scope exists", async () => {
    const ext = await startExtSite();
    try {
      const { ws, home, doc } = sandboxOf(ext.url);
      grantOf(ws, { scripts: false, network: false });
      const { audit, pdf, pngHeight, pngClipped } = await renderOf(doc, ws, home);

      // Sibling assets served from the /f/ layer.
      const served = audit.filter((r) => r.action === "serve" && r.status === 200);
      const servedUrls = served.map((r) => r.url);
      expect(servedUrls.some((u) => u.endsWith("/index.html"))).toBe(true);
      expect(servedUrls.some((u) => u.endsWith("/style.css"))).toBe(true);
      expect(servedUrls.some((u) => u.endsWith("/img.png"))).toBe(true);
      expect(servedUrls.some((u) => u.endsWith("/sub/pic.png"))).toBe(true);

      // The traversal arrives pre-normalized (…/f/secret.png) and gets the uniform 404.
      const traversal = audit.find((r) => r.url.includes("secret"));
      expect(traversal?.action).toBe("serve");
      expect(traversal?.status).toBe(404);

      // data: is an inline fetch — continued, never served or denied.
      const dataReq = audit.find((r) => r.url.startsWith("data:"));
      expect(dataReq?.action).toBe("allow");

      // Nothing external reached the gate's open side: no `allow` for ext URLs.
      expect(ext.hits).toEqual([]);
      expect(audit.filter((r) => isExt(r.url) && r.action === "allow")).toEqual([]);

      // Artifact: css applied (tall page, unclipped), siblings + data embedded,
      // secret + ext absent (a broken icon can't fake a 303px image).
      expect(pngClipped).toBe(false);
      expect(pngHeight).toBeGreaterThanOrEqual(BASELINE_HEIGHT);
      expect(pngHeight).toBeLessThan(BASELINE_HEIGHT + 800);
      expect(Buffer.from(pdf).subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(pdfHasImage(pdf, IMG.w, IMG.h)).toBe(true);
      expect(pdfHasImage(pdf, PIC.w, PIC.h)).toBe(true);
      expect(pdfHasImage(pdf, DATA.w, DATA.h)).toBe(true);
      expect(pdfHasImage(pdf, SECRET.w, SECRET.h)).toBe(false);
      expect(pdfHasImage(pdf, EXT_IMG.w, EXT_IMG.h)).toBe(false);
    } finally {
      await ext.close();
    }
  }, 90_000);

  it("granted scripts + denied network: JS still never runs, network still closed", async () => {
    const ext = await startExtSite();
    try {
      const { ws, home, doc } = sandboxOf(ext.url);
      grantOf(ws, { scripts: true, network: false });
      const { audit, pngHeight, pngClipped } = await renderOf(doc, ws, home);

      // The grant exists and the CSP may allow scripts — but export is a
      // snapshot: no script beacon was ever attempted, and the script's
      // 30000px body stretch never landed in the artifact.
      expect(ext.hits).toEqual([]);
      expect(audit.filter((r) => r.url.includes("beacon-app"))).toEqual([]);
      expect(audit.filter((r) => r.url.includes("beacon-inline"))).toEqual([]);
      expect(audit.filter((r) => isExt(r.url) && r.action === "allow")).toEqual([]);
      expect(pngClipped).toBe(false);
      expect(pngHeight).toBeLessThan(BASELINE_HEIGHT + 800);
    } finally {
      await ext.close();
    }
  }, 90_000);

  it("denied scripts + granted network: external fetches pass the gate, scripts stay inert", async () => {
    const ext = await startExtSite();
    try {
      const { ws, home, doc } = sandboxOf(ext.url);
      grantOf(ws, { scripts: false, network: true });
      const { audit, pngHeight, pngClipped } = await renderOf(doc, ws, home);

      // The granted channels are released to the network — the audit records
      // the verdict; PNA keeps a loopback target off the wire either way.
      expect(audit.some((r) => r.url.endsWith("/beacon-img.png") && r.action === "allow")).toBe(
        true,
      );
      expect(audit.some((r) => r.url.endsWith("/beacon.css") && r.action === "allow")).toBe(true);
      // The ungranted channel: script fetches — never even attempted.
      expect(audit.filter((r) => r.url.includes("beacon-app"))).toEqual([]);
      expect(audit.filter((r) => r.url.includes("beacon-inline"))).toEqual([]);
      expect(ext.hits.filter((h) => h.includes("beacon-app"))).toEqual([]);
      expect(ext.hits.filter((h) => h.includes("beacon-inline"))).toEqual([]);
      expect(pngClipped).toBe(false);
      expect(pngHeight).toBeLessThan(BASELINE_HEIGHT + 800);
    } finally {
      await ext.close();
    }
  }, 90_000);

  it("granted scripts + granted network: only the network half of the grant matters", async () => {
    const ext = await startExtSite();
    try {
      const { ws, home, doc } = sandboxOf(ext.url);
      grantOf(ws, { scripts: true, network: true });
      const { audit, pdf, pngHeight, pngClipped } = await renderOf(doc, ws, home);

      expect(audit.some((r) => r.url.endsWith("/beacon-img.png") && r.action === "allow")).toBe(
        true,
      );
      expect(audit.some((r) => r.url.endsWith("/beacon.css") && r.action === "allow")).toBe(true);
      // The scripts grant buys nothing in export: snapshot semantics kill JS
      // no matter what the permission store says — no beacon attempt anywhere.
      expect(audit.filter((r) => r.url.includes("beacon-app"))).toEqual([]);
      expect(audit.filter((r) => r.url.includes("beacon-inline"))).toEqual([]);
      expect(ext.hits.filter((h) => h.includes("beacon-app"))).toEqual([]);
      expect(ext.hits.filter((h) => h.includes("beacon-inline"))).toEqual([]);
      expect(audit.filter((r) => r.action === "deny" && isExt(r.url))).toEqual([]);
      expect(pngClipped).toBe(false);
      expect(pngHeight).toBeLessThan(BASELINE_HEIGHT + 800);
      // Granted or not, a loopback ext image never lands locally (PNA), and the
      // traversal never lands anywhere.
      expect(pdfHasImage(pdf, SECRET.w, SECRET.h)).toBe(false);
      expect(pdfHasImage(pdf, IMG.w, IMG.h)).toBe(true);
    } finally {
      await ext.close();
    }
  }, 90_000);
});

const ORIGINAL_HEIGHT = 4400 + IMG.h; // marker + natural img — the refresh doc's only signature

/**
 * D40: export is one navigation and one snapshot — a meta refresh (needs no
 * JS, rides no CSP) must never move the page. Same-origin targets are the
 * real hole: /f/ always serves them regardless of permissions, so a refresh
 * paints a served asset as *the document* (or a 404 error page). External
 * targets only differ under a granted network; a denied one already fails
 * the network gate — those cells pin the contract anyway.
 */
describe.skipIf(SKIP_REASON !== null)("foreign export · post-load navigation", () => {
  const COMBOS = [
    ["scripts off + network off", { scripts: false, network: false }],
    ["scripts on + network off", { scripts: true, network: false }],
    ["scripts off + network on", { scripts: false, network: true }],
    ["scripts on + network on", { scripts: true, network: true }],
  ] as const;

  for (const [label, grant] of COMBOS) {
    for (const delay of ["0", "1"]) {
      it(`${label}: a ${delay}s meta refresh to a same-origin path keeps the original snapshot`, async () => {
        const { ws, home, doc } = refreshSandboxOf(delay, "style.css");
        grantOf(ws, grant);
        const { audit, pngHeight } = await pngOf(doc, ws, home);
        // style.css is fetched once as the stylesheet — a second serve would
        // be the refresh navigation receiving it as a *document*.
        expect(
          audit.filter((r) => r.url.endsWith("/style.css") && r.action === "serve"),
        ).toHaveLength(1);
        expect(pngHeight).toBeGreaterThanOrEqual(ORIGINAL_HEIGHT - 400);
        expect(pngHeight).toBeLessThan(ORIGINAL_HEIGHT + 800);
      }, 90_000);

      it(`${label}: a ${delay}s meta refresh to an external URL never reaches the listener`, async () => {
        const ext = await startExtSite();
        try {
          const { ws, home, doc } = refreshSandboxOf(delay, `${ext.url}/stolen.png`);
          grantOf(ws, grant);
          const { pngHeight } = await pngOf(doc, ws, home);
          expect(ext.hits.filter((h) => h.includes("stolen"))).toEqual([]);
          expect(pngHeight).toBeGreaterThanOrEqual(ORIGINAL_HEIGHT - 400);
          expect(pngHeight).toBeLessThan(ORIGINAL_HEIGHT + 800);
        } finally {
          await ext.close();
        }
      }, 90_000);
    }
  }

  it("a refresh to an unservable target still snapshots the original document, not the error page", async () => {
    // The verifier's failure shape: the refresh lands on the uniform 404 and
    // Chrome paints its error document — the artifact must stay the original.
    const { ws, home, doc } = refreshSandboxOf("0", "missing.html");
    grantOf(ws, { scripts: false, network: false });
    const { audit, pngHeight } = await pngOf(doc, ws, home);
    expect(audit.filter((r) => r.url.endsWith("/missing.html") && r.status === 200)).toEqual([]);
    expect(pngHeight).toBeGreaterThanOrEqual(ORIGINAL_HEIGHT - 400);
  }, 90_000);

  it("repeat runs of the same refresh document produce byte-identical PNGs", async () => {
    const { ws, home, doc } = refreshSandboxOf("0", "style.css");
    grantOf(ws, { scripts: true, network: true });
    const first = await pngOf(doc, ws, home);
    const second = await pngOf(doc, ws, home);
    const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
    expect(hash(first.pngBytes)).toBe(hash(second.pngBytes));
    expect(first.pngHeight).toBeGreaterThanOrEqual(ORIGINAL_HEIGHT - 400);
  }, 120_000);
});

const NAMED_HTML =
  "<!DOCTYPE html><html><head></head><body><article><h1>One</h1></article><article><h1>Two</h1></article></body></html>";
const TITLED_HTML =
  "<!DOCTYPE html><html><head><title>Sheet's Own</title></head><body><article><h1>One</h1></article><article><h1>Two</h1></article></body></html>";

const namedSandboxOf = (name: string, html: string): Sandbox => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hr-fx-title-")));
  const ws = join(root, "ws");
  const home = join(root, "home");
  mkdirSync(join(ws, "page"), { recursive: true });
  mkdirSync(home, { recursive: true });
  const doc = join(ws, "page", name);
  writeFileSync(doc, html);
  return { ws, home, doc };
};

const titleOf = (pdf: Uint8Array): string | undefined =>
  /\/Title\s*\(([^)]*)\)/.exec(Buffer.from(pdf).toString("latin1"))?.[1];

/**
 * The PDF /Title metadata falls back to the document URL for an untitled
 * page — verbatim, that is `hreader-export.invalid/f/<cap>/index.html`, the
 * minted capability leaking into the artifact. The export sets the document
 * title to the file name instead; a real <title> always wins.
 */
describe.skipIf(SKIP_REASON !== null)("foreign export · PDF /Title", () => {
  it("uses the raw file name — not the minted URL — when the document has no <title>", async () => {
    // A space in the name separates the channels: a URL-derived fallback
    // would read "my%20report.html"; the leak reads "hreader-export.invalid/f/<cap>/…".
    const { ws, home, doc } = namedSandboxOf("my report.html", NAMED_HTML);
    const { pdf } = await renderOf(doc, ws, home);
    expect(titleOf(pdf)).toBe("my report.html");
  }, 90_000);

  it("keeps the document's own <title> over the file-name fallback", async () => {
    const { ws, home, doc } = namedSandboxOf("titled.html", TITLED_HTML);
    const { pdf } = await renderOf(doc, ws, home);
    expect(titleOf(pdf)).toBe("Sheet's Own");
  }, 90_000);
});

// ---- link annotations: no leaked URL or local path may reach the artifact ----

// Every DOM shape the D44 in-page rewrite missed, plus the shapes it handled:
// an SVG <a href> FIRST (anchor.href is SVGAnimatedString there — the old
// evaluate threw and left every later link annotated), xlink:href, declarative
// shadow DOM (invisible to light-DOM querySelectorAll), an <area> imagemap,
// a javascript: scheme, and the ordinary sibling/subdir/../absolute/query
// forms. The post-processor verdict never looks at the DOM, so all of them
// collapse to the same rule: http/https/mailto off the export host survives.
const LINKS_HTML = `<!DOCTYPE html><html><head>
<script>
  fetch("{{EXT}}/beacon-inline.png");
  document.documentElement.setAttribute("data-pwned", "1");
</script>
</head><body>
<svg viewBox="0 0 10 10"><a href="svg-first.png"><text x="0" y="5">svg</text></a></svg>
<article><h1 id="sec">One</h1></article><article><h1>Two</h1></article>
<a href="img.png">sibling</a>
<a href="sub/pic.png">subdir</a>
<a href="../secret.png">outside</a>
<a href="/f/other/x.png">absolute-f</a>
<a href="./x.png?q=1#frag">query-frag</a>
<a href="#sec">fragment</a>
<a href="https://example.com/ext.png">external</a>
<a href="javascript:fetch('{{EXT}}/js-scheme.png')">js-scheme</a>
<a href="mailto:a@b.c">mail</a>
<svg xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><a xlink:href="svg-xlink.png"><text x="0" y="5">xlink</text></a></svg>
<template shadowrootmode="open"><a href="shadow.png">shadow</a></template>
<img usemap="#m" src="img.png" width="40" height="40"><map name="m"><area shape="rect" coords="0,0,20,20" href="area.png" alt="a"></map>
</body></html>`;

const linksSandboxOf = (ext: string): Sandbox => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hr-fx-links-")));
  const ws = join(root, "ws");
  const home = join(root, "home");
  mkdirSync(join(ws, "page", "sub"), { recursive: true });
  mkdirSync(home, { recursive: true });
  const doc = join(ws, "page", "index.html");
  writeFileSync(doc, LINKS_HTML.split("{{EXT}}").join(ext));
  writeFileSync(join(ws, "page", "img.png"), IMG.bytes);
  writeFileSync(join(ws, "page", "sub", "pic.png"), PIC.bytes);
  writeFileSync(join(ws, "secret.png"), SECRET.bytes);
  return { ws, home, doc };
};

// A single <article> with no data-hr-id is normalizable (sheet path, no gate);
// the same body carrying a valid id is managed. Their relative links resolve
// against the sheet's file:// temp dir — the pre-D45 leak this file's
// normalizable case pins closed.
const SHEET_HTML = `<!DOCTYPE html><html><head></head><body>
<article{{ID}}><h1 id="sec">One</h1>
<a href="img.png">sibling</a>
<a href="https://example.com/sheet.png">external</a>
</article></body></html>`;

const sheetSandboxOf = (html: string): Sandbox => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hr-fx-sheet-")));
  const ws = join(root, "ws");
  const home = join(root, "home");
  mkdirSync(join(ws, "page"), { recursive: true });
  mkdirSync(home, { recursive: true });
  const doc = join(ws, "page", "index.html");
  writeFileSync(doc, html);
  return { ws, home, doc };
};

/** `hr pdf` end-to-end in-process: the command reads, plans, renders through real Chrome, sanitizes and writes. */
const commandPdfOf = async (
  doc: string,
  ws: string,
  home: string,
  audit: ExportRequestRecord[],
): Promise<Uint8Array> => {
  const out = join(ws, "out.pdf");
  await pdfCommand({
    path: doc,
    pageSize: "a4",
    timeoutMs: 30_000,
    outline: true,
    outlineConflict: false,
    visual: undefined,
    out,
    force: false,
    workspace: ws,
    home,
    json: false,
    warn: () => undefined,
    render: (input) =>
      renderPdfOf({
        ...input,
        stop: NEVER,
        deps: depsOf(),
        audit: (r) => {
          audit.push(r);
        },
      }),
  });
  return readFileSync(out);
};

interface LinkAnnots {
  /** Text of every `/URI` action across all `/Link` annotations. */
  readonly uris: string[];
  /** Name of every `/Dest` reference (internal links). */
  readonly dests: string[];
}

/** pdf-lib walk: every page's /Annots -> /Subtype /Link -> /A /URI and /Dest. */
const linkAnnotsOf = async (pdf: Uint8Array): Promise<LinkAnnots> => {
  const document = await PDFDocument.load(pdf);
  const uris: string[] = [];
  const dests: string[] = [];
  for (const page of document.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (annots === undefined) continue;
    for (const entry of annots.asArray()) {
      const annot = entry instanceof PDFRef ? document.context.lookup(entry) : entry;
      if (!(annot instanceof PDFDict)) continue;
      if (annot.get(PDFName.of("Subtype"))?.toString() !== "/Link") continue;
      const dest = annot.get(PDFName.of("Dest"));
      if (dest !== undefined) dests.push(dest.toString());
      const action = annot.get(PDFName.of("A"));
      const act = action instanceof PDFRef ? document.context.lookup(action) : action;
      if (!(act instanceof PDFDict)) continue;
      const uri = act.get(PDFName.of("URI"));
      if (uri instanceof PDFString || uri instanceof PDFHexString) {
        uris.push(uri.decodeText());
      }
    }
  }
  return { uris, dests };
};

/**
 * A same-origin anchor resolves onto the minted capability URL, and
 * printToPDF stamps that URL verbatim into the PDF's /URI annotations —
 * a dead `hreader-export.invalid` link leaking the capability. `hr pdf`
 * passes every artifact through a PDF-level post-processor before writing
 * (D45): /URI annotations survive only when the scheme is http/https/mailto
 * and the host is not the export origin; /Dest internal links are kept.
 * The verdict never consults the DOM, so DOM shapes no rewrite could reach
 * — SVG anchors, shadow roots, imagemaps — sanitize identically.
 */
describe.skipIf(SKIP_REASON !== null)("foreign export · PDF link annotations", () => {
  it("keeps only the allowlisted URIs across every DOM link shape", async () => {
    const ext = await startExtSite();
    try {
      const { ws, home, doc } = linksSandboxOf(ext.url);
      const audit: ExportRequestRecord[] = [];
      const pdf = await commandPdfOf(doc, ws, home, audit);
      const { uris, dests } = await linkAnnotsOf(pdf);

      // The cap rides on the served /f/ request URLs, not the plan handle.
      const cap = /\/f\/([^/]+)\//.exec(
        audit.find((r) => r.action === "serve")?.url ?? "",
      )?.[1] ?? "";
      expect(cap.length).toBeGreaterThan(0);

      // The leak oracle: no annotation may carry the minted origin, the cap,
      // a file: URL, or any local path — the exporting machine's layout must
      // never reach the artifact.
      const localDirs = [ws, home, dirname(doc)];
      for (const uri of uris) {
        expect(uri.startsWith("file:")).toBe(false);
        expect(uri).not.toContain("hreader-export.invalid");
        expect(uri).not.toContain(cap);
        for (const dir of localDirs) {
          expect(uri).not.toContain(dir);
        }
      }
      // The exact surviving set: the external link and the mailto — every
      // same-origin shape, the javascript: link, and the /f/ absolute link
      // produce no annotation at all.
      expect([...uris].sort()).toEqual(
        ["https://example.com/ext.png", "mailto:a@b.c"].sort(),
      );
      // The fragment link stays an internal /Dest — never a URI annotation.
      expect(dests.some((d) => d.endsWith("sec"))).toBe(true);
      expect(dests.every((d) => !d.includes("secret"))).toBe(true);

      // The sanitizer runs under the same snapshot contract: the inline
      // script's beacon never fired and its DOM flag never landed.
      expect(ext.hits).toEqual([]);
      expect(audit.filter((r) => r.url.includes("beacon"))).toEqual([]);
    } finally {
      await ext.close();
    }
  }, 90_000);

  it("strips the temp-dir file: URI a normalizable doc's relative link would leave", async () => {
    const { ws, home, doc } = sheetSandboxOf(SHEET_HTML.split("{{ID}}").join(""));
    const audit: ExportRequestRecord[] = [];
    const pdf = await commandPdfOf(doc, ws, home, audit);
    const { uris } = await linkAnnotsOf(pdf);

    // No file: and no local path — the sheet's temp dir must not leak.
    for (const uri of uris) {
      expect(uri.startsWith("file:")).toBe(false);
      expect(uri).not.toContain(ws);
      expect(uri).not.toContain(dirname(doc));
    }
    // The sheet's own TOC lands as /Dest; the only /URI is the external link.
    expect(uris).toEqual(["https://example.com/sheet.png"]);
  }, 90_000);

  it("keeps a managed doc's benign external link through the same sanitizer", async () => {
    const { ws, home, doc } = sheetSandboxOf(
      SHEET_HTML.split("{{ID}}").join(' data-hr-id="hr-doc"'),
    );
    const audit: ExportRequestRecord[] = [];
    const pdf = await commandPdfOf(doc, ws, home, audit);
    const { uris } = await linkAnnotsOf(pdf);
    expect(uris).toEqual(["https://example.com/sheet.png"]);
  }, 90_000);
});
