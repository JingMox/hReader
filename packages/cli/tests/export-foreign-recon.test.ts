// Recon evidence for F1d: what `hr pdf`/`hr png`/`hr export` do to a FOREIGN
// document today (two <article> elements = `classifyDocument` "foreign").
// Facts pinned here, before the permission-aware export lands:
//   1. the command never loads the raw file into Chrome — it hands the render
//      layer a print sheet built with the `print` sanitize preset;
//   2. the preset strips every executable surface, so scripts cannot run;
//   3. every non-`data:image/` resource is dropped — sibling assets AND
//      external resources alike, so nothing external can be requested;
//   4. only the first <article> is exported;
//   5. a 0-article foreign document fails with `no_article`;
//   6. grants in `.hreader/trust.json` change nothing — the export path
//      never reads permissions at all.
// Cases asserting behavior the F1d fix intentionally changes are updated by
// the fix commit; the print-sheet facts stay true for the managed path.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

import { HrError } from "@hreader/core";
import { describe, expect, it } from "vitest";

import { printProductOf } from "../src/commands/export-print";
import { pdfCommand, type PdfCommandInput, type RenderPdf } from "../src/commands/pdf";
import { pngCommand, type PngCommandInput, type RenderPng } from "../src/commands/png";
import { pdfOf, pngOf } from "./chrome-helpers";

const FOREIGN = [
  "<!DOCTYPE html>",
  "<html><head>",
  "<title>foreign</title>",
  '<link rel="stylesheet" href="style.css">',
  "<script>window.__ran = true;</script>",
  '<script src="app.js"></script>',
  "</head><body>",
  "<article><h1>First</h1><p>alpha</p>",
  '<img src="img.png">',
  '<img src="https://cdn.example/x.png">',
  "</article>",
  "<article><h1>Second</h1><p>beta</p></article>",
  '<iframe src="other.html"></iframe>',
  '<a href="javascript:alert(1)">link</a>',
  '<p onclick="boom()">clickable</p>',
  "</body></html>",
].join("\n");

const NO_ARTICLE = "<!DOCTYPE html><html><body><p>no article here</p></body></html>";

interface Sandbox {
  readonly dir: string;
  readonly doc: string;
}

const sandboxOf = (html: string): Sandbox => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hr-recon-")));
  mkdirSync(join(dir, "page"), { recursive: true });
  const doc = join(dir, "page", "index.html");
  writeFileSync(doc, html);
  return { dir, doc };
};

const printInputOf = (doc: string, dir: string, warn: (m: string) => void) => ({
  path: doc,
  visual: undefined,
  paper: "a4" as const,
  workspace: dir,
  warn,
});

const pdfInputOf = (doc: string, dir: string, render: RenderPdf): PdfCommandInput => ({
  path: doc,
  pageSize: "a4",
  timeoutMs: 60_000,
  outline: true,
  outlineConflict: false,
  visual: undefined,
  out: join(dir, "out.pdf"),
  force: false,
  workspace: dir,
  json: false,
  warn: () => undefined,
  render,
});

const pngInputOf = (doc: string, dir: string, render: RenderPng): PngCommandInput => ({
  path: doc,
  width: "800",
  scale: "1",
  maxHeight: "20000",
  maxHeightExplicit: false,
  outlineFlag: undefined,
  timeoutMs: 60_000,
  visual: undefined,
  out: join(dir, "out.png"),
  force: false,
  workspace: dir,
  json: false,
  warn: () => undefined,
  render,
});

describe("foreign document export · current print-sheet behavior (recon)", () => {
  it("should render the print skeleton, not the raw document", async () => {
    const { dir, doc } = sandboxOf(FOREIGN);
    const product = await printProductOf(printInputOf(doc, dir, () => undefined));
    expect(product.html).toContain("cover__title");
    expect(product.html).toContain('class="hr-print"');
    expect(product.html).toContain('class="hr-theme"');
    // Only the first <article> is exported: the second never reaches the sheet.
    expect(product.html).toContain("First");
    expect(product.html).not.toContain("Second");
    expect(product.html).not.toContain("beta");
  });

  it("should strip every executable surface before Chrome ever sees it", async () => {
    const { dir, doc } = sandboxOf(FOREIGN);
    const product = await printProductOf(printInputOf(doc, dir, () => undefined));
    expect(product.html).not.toContain("<script");
    expect(product.html).not.toContain("app.js");
    expect(product.html).not.toContain("onclick");
    expect(product.html).not.toContain("javascript:");
    expect(product.html).not.toContain("<iframe");
    expect(product.html).not.toContain("other.html");
    expect(product.html).not.toContain("<link");
  });

  it("should drop sibling and external resources alike — nothing left to request", async () => {
    const { dir, doc } = sandboxOf(FOREIGN);
    const warnings: string[] = [];
    const product = await printProductOf(
      printInputOf(doc, dir, (m) => {
        warnings.push(m);
      }),
    );
    // The sibling img.png dies by the same rule as https://cdn.example: any
    // non-`data:image/` src is an "external image" to the print preset.
    expect(product.droppedImages).toBe(2);
    expect(product.html).not.toContain("img.png");
    expect(product.html).not.toContain("cdn.example");
    expect(product.html).not.toContain("style.css");
    expect(warnings.join("")).toContain("已移除 2 个外部图片");
  });

  it("should fail a 0-article foreign document with no_article", async () => {
    const { dir, doc } = sandboxOf(NO_ARTICLE);
    const error = await printProductOf(printInputOf(doc, dir, () => undefined)).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(HrError);
    expect((error as HrError).code).toBe("no_article");
  });

  it("should hand pdf the sanitized sheet even when a grant exists", async () => {
    const { dir, doc } = sandboxOf(FOREIGN);
    // trust.json grants scripts+network — the export path does not read it.
    mkdirSync(join(dir, ".hreader"), { recursive: true });
    writeFileSync(
      join(dir, ".hreader", "trust.json"),
      JSON.stringify({ "page/index.html": { scripts: true, network: true } }),
    );
    const seen: string[] = [];
    await pdfCommand(
      pdfInputOf(doc, dir, (input) => {
        seen.push(input.html);
        return Promise.resolve({ bytes: Buffer.from(pdfOf(1)) });
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("cover__title");
    expect(seen[0]).not.toContain("<script");
    expect(seen[0]).not.toContain("img.png");
    expect(seen[0]).not.toContain("cdn.example");
    expect(seen[0]).not.toContain("other.html");
  });

  it("should hand png the same sanitized sheet", async () => {
    const { dir, doc } = sandboxOf(FOREIGN);
    const seen: string[] = [];
    await pngCommand(
      pngInputOf(doc, dir, (input) => {
        seen.push(input.html);
        return Promise.resolve({
          bytes: pngOf(800, 600),
          width: 800,
          height: 600,
          clipped: false,
        });
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("cover__title");
    expect(seen[0]).not.toContain("<script");
    expect(seen[0]).not.toContain("img.png");
    expect(seen[0]).not.toContain("onclick");
  });
});
