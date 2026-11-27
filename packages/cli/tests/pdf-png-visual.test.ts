// This layer aligns `hr pdf`/`hr png` theme rules with `hr export` —
// both commands once welded `DEFAULT_STYLE_ID` into the command layer, so a style picked via `hr new --visual X` was silently swapped in print artifacts,
// and the user had no way to theme pdf/png. The contract: the same `--visual` as `hr export`.

import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { pdfCommand, type PdfCommandInput, type RenderPdf } from "../src/commands/pdf";
import { pngCommand, type PngCommandInput, type RenderPng } from "../src/commands/png";
import { pdfOf, pngOf, sheetHtmlOf } from "./chrome-helpers";
import { expectFailure, parse } from "./args-helpers";
import { withTempDir } from "./harness";

const DOC = "<html><body><article><h1>标题</h1><p>正文</p></article></body></html>";

const withDir = async (run: (dir: string) => Promise<void>): Promise<void> =>
  withTempDir(async (raw) => {
    const dir = realpathSync(raw);
    writeFileSync(join(dir, "doc.html"), DOC);
    await run(dir);
  });

describe("parseArgs · pdf/png --visual", () => {
  it("should leave visual undefined when --visual is not given (doc theme wins)", () => {
    // The default is no longer welded to DEFAULT_STYLE_ID here: the command layer first takes the doc's embedded `#hr-theme`,
    // and only falls back to the default theme when the doc has none.
    expect(parse(["pdf", "a.html", "--out", "o.pdf"])).toMatchObject({
      ok: true,
      intent: { visual: undefined },
    });
    expect(parse(["png", "a.html", "--out", "o.png"])).toMatchObject({
      ok: true,
      intent: { visual: undefined },
    });
  });

  it("should take --visual through to the intent for both commands", () => {
    expect(parse(["pdf", "a.html", "--out", "o.pdf", "--visual", "deck-noir"])).toMatchObject({
      ok: true,
      intent: { kind: "pdf", visual: "deck-noir" },
    });
    expect(parse(["png", "a.html", "--out", "o.png", "--visual=deck-noir"])).toMatchObject({
      ok: true,
      intent: { kind: "png", visual: "deck-noir" },
    });
  });

  it("should reject an empty --visual like hr export does", () => {
    expectFailure(["pdf", "a.html", "--out", "o.pdf", "--visual="], "--visual 不能为空", "pdf");
    expectFailure(["png", "a.html", "--out", "o.png", "--visual="], "--visual 不能为空", "png");
  });
});

describe("pdfCommand · theme passthrough", () => {
  const inputOf = (
    dir: string,
    visual: string | undefined,
    render: RenderPdf,
  ): PdfCommandInput => ({
    path: join(dir, "doc.html"),
    pageSize: "a4",
    timeoutMs: 60_000,
    outline: true,
    outlineConflict: false,
    out: join(dir, "out.pdf"),
    force: false,
    workspace: dir,
    home: dir,
    json: false,
    warn: () => undefined,
    visual,
    render,
  });

  it("should render the print product with the requested visual", async () => {
    await withDir(async (dir) => {
      let html = "";
      const render: RenderPdf = (input) => {
        html = sheetHtmlOf(input.source);
        return Promise.resolve({ bytes: Buffer.from(pdfOf(1)) });
      };
      await pdfCommand(inputOf(dir, "deck-noir", render));

      expect(html).toContain("hr-visual-deck-noir");
      expect(html).not.toContain("hr-visual-atelier-editorial");
    });
  });

  it("should fold an unknown --visual into unknown_style", async () => {
    await withDir(async (dir) => {
      const render: RenderPdf = () => Promise.resolve({ bytes: Buffer.from(pdfOf(1)) });
      const code = await pdfCommand(inputOf(dir, "no-such-visual", render)).then(
        () => "",
        (error: unknown) =>
          error instanceof Error && "code" in error ? String(error.code) : String(error),
      );

      expect(code).toBe("unknown_style");
    });
  });

  it("should reuse the document's embedded #hr-theme when --visual is not given", async () => {
    const themed =
      '<html><head><style id="hr-theme">:root{--hr-bg:#123456}.doc-only{color:#123456}</style></head>' +
      "<body><article><h1>标题</h1><p>正文</p></article></body></html>";
    await withDir(async (dir) => {
      writeFileSync(join(dir, "doc.html"), themed);
      let html = "";
      const render: RenderPdf = (input) => {
        html = sheetHtmlOf(input.source);
        return Promise.resolve({ bytes: Buffer.from(pdfOf(1)) });
      };
      await pdfCommand(inputOf(dir, undefined, render));

      expect(html).toContain(".doc-only{color:#123456}");
      expect(html).toContain('content="document"');
      expect(html).not.toContain("--hr-bg: #faf8f5");
    });
  });

  it("should fall back to the default theme when the doc has no #hr-theme", async () => {
    await withDir(async (dir) => {
      let html = "";
      const render: RenderPdf = (input) => {
        html = sheetHtmlOf(input.source);
        return Promise.resolve({ bytes: Buffer.from(pdfOf(1)) });
      };
      await pdfCommand(inputOf(dir, undefined, render));

      expect(html).toContain("hr-visual-atelier-editorial");
      expect(html).toContain("--hr-bg: #faf8f5");
    });
  });
});

describe("pngCommand · theme passthrough", () => {
  it("should render the print product with the requested visual", async () => {
    await withDir(async (dir) => {
      let html = "";
      const render: RenderPng = (input) => {
        html = sheetHtmlOf(input.source);
        return Promise.resolve({
          bytes: pngOf(256, 10),
          width: 256,
          height: 10,
          clipped: false,
        });
      };
      const input: PngCommandInput = {
        path: join(dir, "doc.html"),
        out: join(dir, "out.png"),
        width: "256",
        scale: "1",
        maxHeight: "20000",
        maxHeightExplicit: false,
        outlineFlag: undefined,
        timeoutMs: 60_000,
        force: false,
        workspace: dir,
        home: dir,
        json: false,
        warn: () => undefined,
        visual: "deck-noir",
        render,
      };
      await pngCommand(input);

      expect(html).toContain("hr-visual-deck-noir");
    });
  });

  it("should reuse the document's embedded #hr-theme when --visual is not given", async () => {
    const themed =
      '<html><head><style id="hr-theme">:root{--hr-bg:#654321}.png-only{color:#654321}</style></head>' +
      "<body><article><h1>标题</h1><p>正文</p></article></body></html>";
    await withDir(async (dir) => {
      writeFileSync(join(dir, "doc.html"), themed);
      let html = "";
      const render: RenderPng = (input) => {
        html = sheetHtmlOf(input.source);
        return Promise.resolve({
          bytes: pngOf(256, 10),
          width: 256,
          height: 10,
          clipped: false,
        });
      };
      await pngCommand({
        path: join(dir, "doc.html"),
        out: join(dir, "out.png"),
        width: "256",
        scale: "1",
        maxHeight: "20000",
        maxHeightExplicit: false,
        outlineFlag: undefined,
        timeoutMs: 60_000,
        force: false,
        workspace: dir,
        home: dir,
        json: false,
        warn: () => undefined,
        visual: undefined,
        render,
      });

      expect(html).toContain(".png-only{color:#654321}");
      expect(html).not.toContain("hr-visual-atelier-editorial");
    });
  });
});
