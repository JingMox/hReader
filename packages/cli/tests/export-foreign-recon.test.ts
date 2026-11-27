// Recon evidence for F1d: what `hr pdf`/`hr png`/`hr export` did to a FOREIGN
// document before the permission-aware export (two <article> elements =
// `classifyDocument` "foreign"). Facts pinned by the recon commit; the fix
// commit updated the cases whose behavior changed:
//   1. `printProductOf` still builds the `print`-preset sheet — it is the
//      managed/normalizable path, unchanged;
//   2. the preset strips every executable surface and every non-`data:image/`
//      resource — sibling assets AND external ones alike (was true then, is
//      still true of the sheet path);
//   3. only the first <article> reaches the sheet; a 0-article foreign
//      document fails `no_article` at the product layer;
//   4. CHANGED BY THE FIX: `hr pdf`/`hr png` no longer hand the sheet to
//      Chrome for foreign docs — they hand a `{kind:"foreign"}` source with a
//      capability URL and a request gate, so permissions now apply.

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
import type { RenderSource } from "../src/chrome/types";
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
  home: dir,
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
  home: dir,
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

  it("should hand pdf a capability-gated foreign source now — grants are read", async () => {
    const { dir, doc } = sandboxOf(FOREIGN);
    // trust.json grants scripts+network — the export path resolves it (and the
    // browser still refuses to execute scripts: the snapshot contract).
    mkdirSync(join(dir, ".hreader"), { recursive: true });
    writeFileSync(
      join(dir, ".hreader", "trust.json"),
      JSON.stringify({ "page/index.html": { scripts: true, network: true } }),
    );
    const seen: RenderSource[] = [];
    await pdfCommand(
      pdfInputOf(doc, dir, (input) => {
        seen.push(input.source);
        return Promise.resolve({ bytes: Buffer.from(pdfOf(1)) });
      }),
    );
    expect(seen).toHaveLength(1);
    const source = seen[0];
    if (source?.kind !== "foreign") {
      throw new Error("expected the foreign render source");
    }
    expect(source.page.url).toMatch(
      /^http:\/\/hreader-export\.invalid\/f\/[A-Za-z0-9_-]{22}\/index\.html$/,
    );
    // The serving half answers the doc itself from raw bytes, permission CSP included.
    const answer = await source.page.gate(source.page.url, "GET");
    expect(answer.kind).toBe("serve");
    if (answer.kind !== "serve") return;
    expect(answer.reply.status).toBe(200);
    expect(String(answer.reply.headers["content-security-policy"])).toContain("sandbox");
    expect(String(answer.reply.body)).toContain("<script>window.__ran = true;</script>");
  });

  it("should hand png the same foreign source", async () => {
    const { dir, doc } = sandboxOf(FOREIGN);
    const seen: RenderSource[] = [];
    await pngCommand(
      pngInputOf(doc, dir, (input) => {
        seen.push(input.source);
        return Promise.resolve({
          bytes: pngOf(800, 600),
          width: 800,
          height: 600,
          clipped: false,
        });
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe("foreign");
  });
});
