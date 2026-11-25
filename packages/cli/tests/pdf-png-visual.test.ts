// 这层管：`hr pdf`/`hr png` 的主题口径与 `hr export` 对齐——
// 曾经两条命令把 `DEFAULT_STYLE_ID` 焊死在命令层，`hr new --visual X` 选的样式在打印产物里被静默换掉，
// 用户没有任何办法让 pdf/png 用别的主题。契约：与 `hr export` 同一支 `--visual`。

import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { pdfCommand, type PdfCommandInput, type RenderPdf } from "../src/commands/pdf";
import { pngCommand, type PngCommandInput, type RenderPng } from "../src/commands/png";
import { pdfOf, pngOf } from "./chrome-helpers";
import { expectFailure, parse } from "./args-helpers";
import { withTempDir } from "./harness";

const DOC = "<html><body><article><h1>标题</h1><p>正文</p></article></body></html>";

const withDir = async (run: (dir: string) => Promise<void>): Promise<void> =>
  withTempDir(async (raw) => {
    const dir = realpathSync(raw);
    writeFileSync(join(dir, "doc.html"), DOC);
    await run(dir);
  });

describe("parseArgs · pdf/png 的 --visual", () => {
  it("should default to the same DEFAULT_STYLE_ID export uses", () => {
    expect(parse(["pdf", "a.html", "--out", "o.pdf"])).toMatchObject({
      ok: true,
      intent: { visual: "atelier-editorial" },
    });
    expect(parse(["png", "a.html", "--out", "o.png"])).toMatchObject({
      ok: true,
      intent: { visual: "atelier-editorial" },
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

describe("pdfCommand · 主题透传", () => {
  const inputOf = (dir: string, visual: string, render: RenderPdf): PdfCommandInput => ({
    path: join(dir, "doc.html"),
    pageSize: "a4",
    timeoutMs: 60_000,
    outline: true,
    outlineConflict: false,
    out: join(dir, "out.pdf"),
    force: false,
    workspace: dir,
    json: false,
    warn: () => undefined,
    visual,
    render,
  });

  it("should render the print product with the requested visual", async () => {
    await withDir(async (dir) => {
      let html = "";
      const render: RenderPdf = (input) => {
        html = input.html;
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
});

describe("pngCommand · 主题透传", () => {
  it("should render the print product with the requested visual", async () => {
    await withDir(async (dir) => {
      let html = "";
      const render: RenderPng = (input) => {
        html = input.html;
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
        json: false,
        warn: () => undefined,
        visual: "deck-noir",
        render,
      };
      await pngCommand(input);

      expect(html).toContain("hr-visual-deck-noir");
    });
  });
});
