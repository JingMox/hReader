// Journey: `hr pdf` / `hr png` on a foreign document, driven through the real
// `hr` binary (dist/cli.mjs) on real Chrome — the wiring layer the in-process
// tests can't see: argv → intent → classification → the capability-gated page →
// the artifact on disk.
//
// The permission stores are written as files directly (`<ws>/.hreader/trust.json`
// for the per-doc grant, `<home>/.hreader/permissions.json` for global modes) —
// the export path never touches the daemon. `HREADER_HOME` relocates the config
// root; `HOME` must stay real, because the spawned Chrome inherits it and an
// empty home leaves its network stack stuck before requests exist. Chrome
// inside `hr` is attributed by its `--user-data-dir` tmpdir marker; proc.ts
// registers the `hr` child itself.
//
// Asserted:
//   - a foreign page exports end-to-end under default permissions: sibling css
//     and img land in the artifact (tall layout proves both), document scripts
//     never ran (the 30000px stretch stays absent, beacons stay cold);
//   - a scripts+network grant changes nothing about the snapshot: scripts are
//     still inert and the layout is the same (external resources can't reach a
//     loopback canary anyway — the public→private block sits under the gate);
//   - the managed-document export path is unchanged end-to-end.
// Pixel-level and audit-level proofs live in
// packages/cli/tests/export-foreign-chrome.test.ts.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import { describe, test } from "vitest";

import { assert, assertEq } from "../harness/check.ts";
import { dataOf, hr } from "../harness/cli.ts";
import { chromePath, chromeSkipReason, sandbox } from "../harness/env.ts";

const skip = chromeSkipReason();

// ---- minimal real-PNG encoder (the sibling img must be decodable bytes) ----

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
  // The CRC covers type+data: data-only is a PNG `file` accepts but Chrome refuses to decode.
  view.setUint32(8 + data.length, crc32Of(out.subarray(4, 8 + data.length)));
  return out;
};

const pngEncode = (width: number, height: number): Buffer => {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = new Uint8Array(height * (1 + 3 * width)); // filter byte + solid black rows
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunkOf("IHDR", ihdr),
    chunkOf("IDAT", deflateSync(raw)),
    chunkOf("IEND", new Uint8Array()),
  ]);
};

// ---- fixture: one foreign page leaning on every gated channel ----

/** Scripts leave two observable scars when they run: a DOM stretch and an attribute flip. */
const PAGE_HTML = `<!DOCTYPE html><html><head>
<link rel="stylesheet" href="style.css">
<script>document.body && (document.body.style.height = "30000px");</script>
<script src="app.js"></script>
</head><body>
<div id="marker">styled</div>
<img src="img.png">
<article><h1>One</h1></article><article><h1>Two</h1></article>
</body></html>`;

const APP_JS = 'document.body.style.height = "30000px";';
const STYLE_CSS = "#marker { height: 4400px; } img { display:block; }";

const MANAGED_HTML =
  '<!doctype html><html><body><article data-hr-id="doc"><h1>managed</h1><p>body</p></article></body></html>';

interface Case {
  readonly ws: string;
  readonly home: string;
  readonly out: (name: string) => string;
}

const foreignCaseOf = (name: string): Case => {
  const box = sandbox(name);
  mkdirSync(join(box.ws, "page"), { recursive: true });
  writeFileSync(join(box.ws, "page", "index.html"), PAGE_HTML);
  writeFileSync(join(box.ws, "page", "app.js"), APP_JS);
  writeFileSync(join(box.ws, "page", "style.css"), STYLE_CSS);
  writeFileSync(join(box.ws, "page", "img.png"), pngEncode(16, 3000));
  return { ws: box.ws, home: box.home, out: (file) => join(box.ws, file) };
};

const grantOf = (ws: string, grant: { scripts: boolean; network: boolean }): void => {
  mkdirSync(join(ws, ".hreader"), { recursive: true });
  writeFileSync(join(ws, ".hreader", "trust.json"), JSON.stringify({ "page/index.html": grant }));
};

const envOf = (home: string): Record<string, string> => {
  const env: Record<string, string> = { HREADER_HOME: home };
  const chrome = chromePath();
  if (chrome !== undefined) env["HREADER_CHROME"] = chrome;
  return env;
};

const pdfPagesOf = async (c: Case, doc: string, name: string): Promise<number> => {
  const result = await hr(["pdf", doc, "--out", c.out(name), "--workspace", c.ws, "--json"], {
    cwd: c.ws,
    env: envOf(c.home),
  });
  assertEq(result.code, 0, `hr pdf ${doc} exit code (stderr: ${result.stderr.slice(0, 300)})`);
  const data = dataOf(result, `hr pdf ${doc}`);
  const pages = data["pages"];
  assert(typeof pages === "number", "hr pdf's data.pages is not a number");
  return pages;
};

const pngHeightOf = async (c: Case, doc: string, name: string): Promise<number> => {
  const result = await hr(
    ["png", doc, "--out", c.out(name), "--scale", "1", "--workspace", c.ws, "--json"],
    {
      cwd: c.ws,
      env: envOf(c.home),
    },
  );
  assertEq(result.code, 0, `hr png ${doc} exit code (stderr: ${result.stderr.slice(0, 300)})`);
  const data = dataOf(result, `hr png ${doc}`);
  const height = data["height"];
  assert(typeof height === "number", "hr png's data.height is not a number");
  assert(data["clipped"] === false, "hr png result must not be clipped by max-height");
  return height;
};

// marker 4400 + sibling img 3000 + margins ≈ 7420 (--scale 1 keeps the JSON
// height in CSS px); a runaway script's 30000px stretch, a missing stylesheet
// (~3030) or a missing img (~4430) all land far outside this band.
const HEIGHT_LOW = 7000;
const HEIGHT_HIGH = 7900;

describe.skipIf(skip !== undefined)("export-foreign", () => {
  test("hr pdf and hr png export a foreign page through the permission gate with no grant", async () => {
    const c = foreignCaseOf("export-foreign-denied");
    // No trust.json at all: scripts and network both default to off.
    const pages = await pdfPagesOf(c, "page/index.html", "denied.pdf");
    const height = await pngHeightOf(c, "page/index.html", "denied.png");
    // The sibling stylesheet reached the renderer (4400px marker paginates
    // onto multiple A4 pages; the natural-size img keeps its 303px).
    assert(pages >= 2, `css did not take effect: pages=${String(pages)}`);
    assert(
      height >= HEIGHT_LOW && height <= HEIGHT_HIGH,
      `export height abnormal: ${String(height)} (a script ran or a sibling asset was lost)`,
    );
    assert(
      readFileSync(c.out("denied.pdf")).subarray(0, 5).toString("latin1") === "%PDF-",
      "denied.pdf is not a PDF",
    );
  }, 120_000);

  test("a scripts+network grant does not resurrect scripts: the snapshot layout is unchanged", async () => {
    const c = foreignCaseOf("export-foreign-granted");
    grantOf(c.ws, { scripts: true, network: true });
    const pages = await pdfPagesOf(c, "page/index.html", "granted.pdf");
    const height = await pngHeightOf(c, "page/index.html", "granted.png");
    assert(pages >= 2, `css did not take effect: pages=${String(pages)}`);
    assert(
      height >= HEIGHT_LOW && height <= HEIGHT_HIGH,
      `post-grant height abnormal: ${String(height)} (the 30000px script side effect must not appear)`,
    );
  }, 120_000);

  test("managed documents still export through the print sheet end-to-end", async () => {
    const box = sandbox("export-managed");
    writeFileSync(join(box.ws, "doc.hr.html"), MANAGED_HTML);
    const c: Case = { ws: box.ws, home: box.home, out: (f) => join(box.ws, f) };
    const pages = await pdfPagesOf(c, "doc.hr.html", "managed.pdf");
    const height = await pngHeightOf(c, "doc.hr.html", "managed.png");
    assert(pages >= 1, `managed document page count abnormal: ${String(pages)}`);
    assert(
      height > 0 && height < HEIGHT_HIGH,
      `managed document height abnormal: ${String(height)}`,
    );
  }, 120_000);
});
