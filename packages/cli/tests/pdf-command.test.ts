// This layer covers `pdfCommand`'s in-process behavior (key set / page count / disk write / error routing); rendering is a fake injected render, no Chrome.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { HrError } from "@hreader/core";
import { describe, expect, it } from "vitest";

import { pdfCommand, type PdfCommandInput, type RenderPdf } from "../src/commands/pdf";
import { pdfOf, sheetHtmlOf } from "./chrome-helpers";
import { fieldOf, keysOf, withTempDir } from "./harness";

const DOC = "<html><body><article><h1>标题</h1><p>正文</p></article></body></html>";

const withRealDir = async (run: (dir: string) => Promise<void>): Promise<void> =>
  withTempDir(async (raw) => {
    await run(realpathSync(raw));
  });

/** Every case needs `doc.html` first: factored out so case bodies are all assertions. */
const withDocOf = async (run: (dir: string) => Promise<void>): Promise<void> =>
  withRealDir(async (dir) => {
    writeFileSync(join(dir, "doc.html"), DOC);
    await run(dir);
  });

interface Overrides {
  readonly path?: string;
  readonly pageSize?: string;
  readonly timeoutMs?: number;
  /** Defaults follow the CLI: `--outline` defaults on. */
  readonly outline?: boolean;
  readonly outlineConflict?: boolean;
  readonly out?: string;
  readonly force?: boolean;
  readonly json?: boolean;
  readonly render?: RenderPdf;
}

const inputOf = (dir: string, overrides: Overrides = {}): PdfCommandInput => ({
  path: join(dir, "doc.html"),
  pageSize: "a4",
  timeoutMs: 60_000,
  visual: "atelier-editorial",
  outline: true,
  outlineConflict: false,
  out: join(dir, "out.pdf"),
  force: false,
  json: false,
  warn: () => undefined,
  render: () => Promise.resolve({ bytes: Buffer.from(pdfOf(3)) }),
  workspace: dir,
  home: dir,
  ...overrides,
});

const failureOf = async (promise: Promise<unknown>): Promise<HrError> => {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof HrError) return error;
    throw error;
  }
  throw new Error("expected an HrError to be thrown");
};

const fieldOfDataOf = (text: string): ((key: string) => unknown) => {
  const envelope: unknown = JSON.parse(text);
  const data = fieldOf(envelope, "data");
  return (key) => fieldOf(data, key);
};

describe("pdfCommand · --json key set", () => {
  it("should contain exactly the five keys pdf/bytes/pages/outline/out", async () => {
    await withDocOf(async (dir) => {
      const text = await pdfCommand(inputOf(dir, { json: true }));
      const envelope: unknown = JSON.parse(text);
      expect(keysOf(envelope)).toEqual(["ok", "data"]);
      expect(keysOf(Reflect.get(Object(envelope), "data"))).toEqual([
        "pdf",
        "bytes",
        "pages",
        "outline",
        "out",
      ]);
    });
  });

  it("should count pages by /Type /Page and match bytes/out to the real write", async () => {
    await withDocOf(async (dir) => {
      const out = join(dir, "out.pdf");
      const field = fieldOfDataOf(await pdfCommand(inputOf(dir, { json: true, out })));
      expect(field("pages")).toBe(3);
      expect(field("bytes")).toBe(statSync(out).size);
      expect(field("out")).toBe(out);
      expect(Buffer.from(String(field("pdf")), "base64")).toEqual(readFileSync(out));
    });
  });
});

describe("pdfCommand · human line and render arguments", () => {
  it("should carry out, page count and bookmark count in the human line (bookmark count always printed, 0 included)", async () => {
    await withDocOf(async (dir) => {
      const out = join(dir, "out.pdf");
      const text = await pdfCommand(inputOf(dir, { out }));
      // The fake artifact has no `/Outlines`: `3 页, 0 条书签` is concrete proof "this line always carries M".
      expect(text).toBe(`${out} (3 页, 0 条书签)\n`);
    });
  });

  it("should hand --page-size/--timeout and the printout HTML to the render layer", async () => {
    await withDocOf(async (dir) => {
      const seen: { html: string; pageSize: string; timeoutMs: number }[] = [];
      await pdfCommand(
        inputOf(dir, {
          pageSize: "letter",
          timeoutMs: 1500,
          render: (input) => {
            seen.push({
              html: sheetHtmlOf(input.source),
              pageSize: input.pageSize,
              timeoutMs: input.timeoutMs,
            });
            return Promise.resolve({ bytes: Buffer.from(pdfOf(1)) });
          },
        }),
      );
      expect(seen[0]?.pageSize).toBe("letter");
      expect(seen[0]?.timeoutMs).toBe(1500);
      // The paper must reach `@page`: swapping printToPDF's paper alone does not change the page frame.
      expect(seen[0]?.html).toContain("size: letter;");
      expect(seen[0]?.html).toContain("标题");
    });
  });

  it("should set preferCSSPageSize false for a normal document (the frame obeys --page-size)", async () => {
    await withDocOf(async (dir) => {
      const seen: boolean[] = [];
      await pdfCommand(
        inputOf(dir, {
          render: (input) => {
            seen.push(input.preferCSSPageSize);
            return Promise.resolve({ bytes: Buffer.from(pdfOf(1)) });
          },
        }),
      );
      expect(seen).toEqual([false]);
    });
  });
});

describe("pdfCommand · slides printout", () => {
  const SLIDES_DOC =
    "<html><body>" +
    '<article data-hr-kind="slides">' +
    "<h1>封面页</h1>" +
    "<section><h2>第二页</h2><p>要点</p></section>" +
    "</article>" +
    "</body></html>";

  it("should set preferCSSPageSize true for data-hr-kind=slides (the frame obeys the artifact's @page)", async () => {
    await withRealDir(async (dir) => {
      writeFileSync(join(dir, "doc.html"), SLIDES_DOC);
      const seen: { readonly flag: boolean; readonly html: string }[] = [];
      await pdfCommand(
        inputOf(dir, {
          render: (input) => {
            seen.push({ flag: input.preferCSSPageSize, html: sheetHtmlOf(input.source) });
            return Promise.resolve({ bytes: Buffer.from(pdfOf(2)) });
          },
        }),
      );
      expect(seen[0]?.flag).toBe(true);
      // The landscape page frame is hardcoded in the print skeleton — neither --page-size nor the theme.
      expect(seen[0]?.html).toContain("size: 13.333in 7.5in;");
    });
  });
});

describe("pdfCommand · write gate (exists/--force)", () => {
  it("should refuse to write an existing --out without --force and leave the file alone", async () => {
    await withDocOf(async (dir) => {
      const out = join(dir, "out.pdf");
      writeFileSync(out, "old");
      const error = await failureOf(pdfCommand(inputOf(dir, { out })));
      expect(error.code).toBe("file_exists");
      expect(readFileSync(out, "utf8")).toBe("old");
    });
  });

  it("should overwrite an existing file with --force", async () => {
    await withDocOf(async (dir) => {
      const out = join(dir, "out.pdf");
      writeFileSync(out, "old");
      await pdfCommand(inputOf(dir, { out, force: true }));
      expect(readFileSync(out).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    });
  });
});

describe("pdfCommand · write gate (workspace / permission / paper)", () => {
  it("should refuse to write when --out is outside the workspace (reusing export's escape check)", async () => {
    await withDocOf(async (dir) => {
      const outside = "/tmp/hr-pdf-outside.pdf";
      const error = await failureOf(pdfCommand(inputOf(dir, { out: outside })));
      expect(error.code).toBe("path_outside_workspace");
      expect(existsSync(outside)).toBe(false);
    });
  });

  it("should not even start rendering when the directory is unwritable", async () => {
    await withDocOf(async (dir) => {
      const roDir = join(dir, "ro");
      mkdirSync(roDir);
      chmodSync(roDir, 0o500);
      try {
        const error = await failureOf(pdfCommand(inputOf(dir, { out: join(roDir, "out.pdf") })));
        expect(error.code).toBe("io_failure");
      } finally {
        chmodSync(roDir, 0o700);
      }
    });
  });

  it("should report invalid_input for an illegal --page-size before touching the filesystem", async () => {
    await withDocOf(async (dir) => {
      const error = await failureOf(pdfCommand(inputOf(dir, { pageSize: "b5" })));
      expect(error.code).toBe("invalid_input");
      expect(error.message).toContain("--page-size 只能是 a4 | letter | a5：b5");
    });
  });
});

describe("pdfCommand · artifact validation", () => {
  it("should report render_empty for empty bytes", async () => {
    await withDocOf(async (dir) => {
      const promise = pdfCommand(
        inputOf(dir, { render: () => Promise.resolve({ bytes: new Uint8Array() }) }),
      );
      const error = await failureOf(promise);
      expect(error.code).toBe("render_empty");
      expect(error.message).toContain("没有返回 PDF 字节");
    });
  });

  it("should report render_empty for non-PDF bytes", async () => {
    await withDocOf(async (dir) => {
      const render = (): Promise<{ bytes: Uint8Array }> =>
        Promise.resolve({ bytes: Buffer.from("<html>") });
      const error = await failureOf(pdfCommand(inputOf(dir, { render })));
      expect(error.message).toContain("不是 PDF");
    });
  });

  it("should report render_empty for a PDF with no pages", async () => {
    await withDocOf(async (dir) => {
      const render = (): Promise<{ bytes: Uint8Array }> =>
        Promise.resolve({ bytes: Buffer.from(pdfOf(0)) });
      const error = await failureOf(pdfCommand(inputOf(dir, { render })));
      expect(error.message).toContain("没有页面");
    });
  });

  it("should report render_empty for unparseable PDF bytes", async () => {
    await withDocOf(async (dir) => {
      const render = (): Promise<{ bytes: Uint8Array }> =>
        Promise.resolve({ bytes: Buffer.from("%PDF-1.4\n%%EOF\n") });
      const error = await failureOf(pdfCommand(inputOf(dir, { render })));
      expect(error.code).toBe("render_empty");
    });
  });
});

describe("pdfCommand · link sanitization", () => {
  it("should write the render bytes untouched when no link needs stripping", async () => {
    await withDocOf(async (dir) => {
      const rendered = Buffer.from(pdfOf(2));
      const out = join(dir, "out.pdf");
      await pdfCommand(inputOf(dir, { out, render: () => Promise.resolve({ bytes: rendered }) }));
      // Byte-identical, not merely equivalent: with nothing to strip the
      // sanitizer must not re-serialize, so clean exports never change.
      expect(readFileSync(out)).toEqual(rendered);
    });
  });

  it("should fail closed and write no file when the output cannot be sanitized", async () => {
    await withDocOf(async (dir) => {
      const out = join(dir, "out.pdf");
      // Passes the %PDF header check, then dies inside the sanitizer's parse —
      // the exported bytes must never reach disk unsanitized.
      const error = await failureOf(
        pdfCommand(
          inputOf(dir, {
            out,
            render: () => Promise.resolve({ bytes: Buffer.from("%PDF-1.4\n%%EOF\n") }),
          }),
        ),
      );
      expect(error.code).toBe("render_empty");
      expect(existsSync(out)).toBe(false);
    });
  });
});
