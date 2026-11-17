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

import { pdfCommand, pdfPagesOf, type PdfCommandInput, type RenderPdf } from "../src/commands/pdf";
import { fieldOf } from "../src/chrome/protocol";
import { pdfOf, pdfBase64Of } from "./chrome-helpers";
import { keysOf, withTempDir } from "./harness";

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
  readonly out?: string;
  readonly force?: boolean;
  readonly json?: boolean;
  readonly render?: RenderPdf;
}

const inputOf = (dir: string, overrides: Overrides = {}): PdfCommandInput => ({
  path: overrides.path ?? join(dir, "doc.html"),
  pageSize: overrides.pageSize ?? "a4",
  timeoutMs: overrides.timeoutMs ?? 60_000,
  out: overrides.out ?? join(dir, "out.pdf"),
  force: overrides.force ?? false,
  workspace: dir,
  json: overrides.json ?? false,
  warn: () => undefined,
  render: overrides.render ?? (() => Promise.resolve({ bytes: Buffer.from(pdfOf(3)) })),
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
  it("只含 pdf/bytes/pages/out 四个键", async () => {
    await withDocOf(async (dir) => {
      const text = await pdfCommand(inputOf(dir, { json: true }));
      const envelope: unknown = JSON.parse(text);
      expect(keysOf(envelope)).toEqual(["ok", "data"]);
      expect(keysOf(Reflect.get(Object(envelope), "data"))).toEqual([
        "pdf",
        "bytes",
        "pages",
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
  it("人读行带 out、字节数与页数", async () => {
    await withDocOf(async (dir) => {
      const out = join(dir, "out.pdf");
      const text = await pdfCommand(inputOf(dir, { out }));
      expect(text).toBe(`exported ${out} (${String(statSync(out).size)} bytes, 3 pages)\n`);
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
      // 纸必须进 `@page`：只换 printToPDF 的纸不换版心（§15.1）。
      expect(seen[0]?.html).toContain("size: letter;");
      expect(seen[0]?.html).toContain("标题");
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
        Promise.resolve({ bytes: Buffer.from("%PDF-1.4\n%%EOF\n") });
      const error = await failureOf(pdfCommand(inputOf(dir, { render })));
      expect(error.message).toContain("没有页面");
    });
  });

  it("pdfPagesOf 不把 /Pages 页树节点算成页面", () => {
    expect(pdfPagesOf(Buffer.from(pdfOf(3)))).toBe(3);
    expect(pdfPagesOf(Buffer.from("%PDF-1.4\n%%EOF"))).toBe(0);
    expect(pdfPagesOf(Buffer.from(pdfBase64Of(2), "base64"))).toBe(2);
  });
});

describe("pdfPagesOf · 页数正则边界（M12）", () => {
  // 旧写法 `[^s]` 要求 `Page` 后面还有一个字符，字节流正好以 `/Type /Page` 结尾（无尾随换行）
  // 时就漏掉最后一页并报 0；`\b(?!s)` 必须数得到它（§15.2）。
  it("数得到以 `/Type /Page` 结尾的最后一页", () => {
    expect(pdfPagesOf(Buffer.from("<< /Type /Pages /Count 1 >>\n<< /Type /Page"))).toBe(1);
    expect(pdfPagesOf(Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Page"))).toBe(1);
  });
});
