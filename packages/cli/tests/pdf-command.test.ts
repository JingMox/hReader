// 这层管：`pdfCommand` 的进程内行为（键集 / 页数 / 落盘 / 错误归口）；渲染由假 render 注入，不起 Chrome。
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
import { pdfOf } from "./chrome-helpers";
import { fieldOf, keysOf, withTempDir } from "./harness";

const DOC = "<html><body><article><h1>标题</h1><p>正文</p></article></body></html>";

const withRealDir = async (run: (dir: string) => Promise<void>): Promise<void> =>
  withTempDir(async (raw) => {
    await run(realpathSync(raw));
  });

/** 每个用例都要先有 `doc.html`：抽出来，用例体只剩断言。 */
const withDocOf = async (run: (dir: string) => Promise<void>): Promise<void> =>
  withRealDir(async (dir) => {
    writeFileSync(join(dir, "doc.html"), DOC);
    await run(dir);
  });

interface Overrides {
  readonly path?: string;
  readonly pageSize?: string;
  readonly timeoutMs?: number;
  /** 默认跟 CLI 一致：`--outline` 缺省就是开。 */
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
  outline: true,
  outlineConflict: false,
  out: join(dir, "out.pdf"),
  force: false,
  json: false,
  warn: () => undefined,
  render: () => Promise.resolve({ bytes: Buffer.from(pdfOf(3)) }),
  workspace: dir,
  ...overrides,
});

const failureOf = async (promise: Promise<unknown>): Promise<HrError> => {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof HrError) return error;
    throw error;
  }
  throw new Error("预期抛出 HrError");
};

const fieldOfDataOf = (text: string): ((key: string) => unknown) => {
  const envelope: unknown = JSON.parse(text);
  const data = fieldOf(envelope, "data");
  return (key) => fieldOf(data, key);
};

describe("pdfCommand · --json 键集", () => {
  it("只含 pdf/bytes/pages/outline/out 五个键", async () => {
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

  it("页数按 /Type /Page 计数，bytes/out 与实际落盘一致", async () => {
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

describe("pdfCommand · 人读行与渲染入参", () => {
  it("人读行带 out、页数与书签数（书签数恒印，0 也印）", async () => {
    await withDocOf(async (dir) => {
      const out = join(dir, "out.pdf");
      const text = await pdfCommand(inputOf(dir, { out }));
      // 假产物没有 `/Outlines`：`3 页, 0 条书签` 就是"这一行一定带 M"的残疾证据。
      expect(text).toBe(`${out} (3 页, 0 条书签)\n`);
    });
  });

  it("把 --page-size/--timeout 与打印稿 HTML 一起交给渲染层", async () => {
    await withDocOf(async (dir) => {
      const seen: { html: string; pageSize: string; timeoutMs: number }[] = [];
      await pdfCommand(
        inputOf(dir, {
          pageSize: "letter",
          timeoutMs: 1500,
          render: (input) => {
            seen.push({ html: input.html, pageSize: input.pageSize, timeoutMs: input.timeoutMs });
            return Promise.resolve({ bytes: Buffer.from(pdfOf(1)) });
          },
        }),
      );
      expect(seen[0]?.pageSize).toBe("letter");
      expect(seen[0]?.timeoutMs).toBe(1500);
      // 纸必须进 `@page`：只换 printToPDF 的纸不换版心。
      expect(seen[0]?.html).toContain("size: letter;");
      expect(seen[0]?.html).toContain("标题");
    });
  });

  it("普通文档的 preferCSSPageSize 是 false（页框听 --page-size）", async () => {
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

describe("pdfCommand · slides 打印稿", () => {
  const SLIDES_DOC =
    "<html><body>" +
    '<article data-hr-kind="slides">' +
    "<h1>封面页</h1>" +
    "<section><h2>第二页</h2><p>要点</p></section>" +
    "</article>" +
    "</body></html>";

  it("data-hr-kind=slides 时 preferCSSPageSize=true：页框听产物里的 @page", async () => {
    await withRealDir(async (dir) => {
      writeFileSync(join(dir, "doc.html"), SLIDES_DOC);
      const seen: { readonly flag: boolean; readonly html: string }[] = [];
      await pdfCommand(
        inputOf(dir, {
          render: (input) => {
            seen.push({ flag: input.preferCSSPageSize, html: input.html });
            return Promise.resolve({ bytes: Buffer.from(pdfOf(2)) });
          },
        }),
      );
      expect(seen[0]?.flag).toBe(true);
      // 横版页框在打印骨架里写死，不靠 --page-size 也不靠主题。
      expect(seen[0]?.html).toContain("size: 13.333in 7.5in;");
    });
  });
});

describe("pdfCommand · 落盘闸门（已存在/--force）", () => {
  it("已存在的 --out 不给 --force 就拒写，文件不动", async () => {
    await withDocOf(async (dir) => {
      const out = join(dir, "out.pdf");
      writeFileSync(out, "old");
      const error = await failureOf(pdfCommand(inputOf(dir, { out })));
      expect(error.code).toBe("file_exists");
      expect(readFileSync(out, "utf8")).toBe("old");
    });
  });

  it("--force 覆盖已有文件", async () => {
    await withDocOf(async (dir) => {
      const out = join(dir, "out.pdf");
      writeFileSync(out, "old");
      await pdfCommand(inputOf(dir, { out, force: true }));
      expect(readFileSync(out).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    });
  });
});

describe("pdfCommand · 落盘闸门（workspace / 权限 / 纸张）", () => {
  it("--out 在 workspace 外时拒写（复用 export 的越界判定）", async () => {
    await withDocOf(async (dir) => {
      const outside = "/tmp/hr-pdf-outside.pdf";
      const error = await failureOf(pdfCommand(inputOf(dir, { out: outside })));
      expect(error.code).toBe("path_outside_workspace");
      expect(existsSync(outside)).toBe(false);
    });
  });

  it("目录不可写时渲染都不开始", async () => {
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

  it("非法 --page-size 在触碰文件系统之前就报 invalid_input", async () => {
    await withDocOf(async (dir) => {
      const error = await failureOf(pdfCommand(inputOf(dir, { pageSize: "b5" })));
      expect(error.code).toBe("invalid_input");
      expect(error.message).toContain("--page-size 只能是 a4 | letter | a5：b5");
    });
  });
});

describe("pdfCommand · 产物校验", () => {
  it("空字节报 render_empty", async () => {
    await withDocOf(async (dir) => {
      const promise = pdfCommand(
        inputOf(dir, { render: () => Promise.resolve({ bytes: new Uint8Array() }) }),
      );
      const error = await failureOf(promise);
      expect(error.code).toBe("render_empty");
      expect(error.message).toContain("没有返回 PDF 字节");
    });
  });

  it("不是 PDF 的字节报 render_empty", async () => {
    await withDocOf(async (dir) => {
      const render = (): Promise<{ bytes: Uint8Array }> =>
        Promise.resolve({ bytes: Buffer.from("<html>") });
      const error = await failureOf(pdfCommand(inputOf(dir, { render })));
      expect(error.message).toContain("不是 PDF");
    });
  });

  it("PDF 里没有页面报 render_empty", async () => {
    await withDocOf(async (dir) => {
      const render = (): Promise<{ bytes: Uint8Array }> =>
        Promise.resolve({ bytes: Buffer.from(pdfOf(0)) });
      const error = await failureOf(pdfCommand(inputOf(dir, { render })));
      expect(error.message).toContain("没有页面");
    });
  });

  it("结构解析不出的 PDF 字节报 render_empty", async () => {
    await withDocOf(async (dir) => {
      const render = (): Promise<{ bytes: Uint8Array }> =>
        Promise.resolve({ bytes: Buffer.from("%PDF-1.4\n%%EOF\n") });
      const error = await failureOf(pdfCommand(inputOf(dir, { render })));
      expect(error.code).toBe("render_empty");
    });
  });
});
