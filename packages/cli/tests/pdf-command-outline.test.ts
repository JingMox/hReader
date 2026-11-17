// 这层管：`hr pdf` 的大纲语义（默认开 / 报告值 / 互斥）；渲染层用假 render 注入，不起 Chrome。
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { HrError } from "@hreader/core";
import { describe, expect, it } from "vitest";

import {
  pdfCommand,
  pdfHeadingsOf,
  type PdfCommandInput,
  type RenderPdf,
} from "../src/commands/pdf";
import { fieldOf } from "../src/chrome/protocol";
import { pdfOf } from "./chrome-helpers";
import { withTempDir } from "./harness";

/** h5/h6 进不进 Chrome 的大纲是**未实测项**（留给 e2e 观察）；这里只钉计数含它们。 */
const HEADINGS =
  "<html><body><article><h1>一</h1><p>x</p><h2>二</h2><h5>五</h5>" +
  "<h6>六</h6></article></body></html>";

const PLAIN = "<html><body><article><p>只有正文</p></article></body></html>";

interface Overrides {
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
  workspace: dir,
  json: false,
  warn: () => undefined,
  render: () => Promise.resolve({ bytes: Buffer.from(pdfOf(2)) }),
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

/** `--json` 的 `data` 里取一个键：键集本身由 `pdf-command.test.ts` 钉死。 */
const fieldOfDataOf = (text: string): ((key: string) => unknown) => {
  const data = fieldOf(JSON.parse(text), "data");
  return (key) => fieldOf(data, key);
};

const withDocOf = async (html: string, run: (dir: string) => Promise<void>): Promise<void> =>
  withTempDir(async (raw) => {
    const dir = realpathSync(raw);
    writeFileSync(join(dir, "doc.html"), html);
    await run(dir);
  });

const outlineOf = async (html: string, overrides: Overrides = {}): Promise<unknown> => {
  let seen: unknown;
  await withDocOf(html, async (dir) => {
    const text = await pdfCommand(inputOf(dir, { ...overrides, json: true }));
    seen = fieldOfDataOf(text)("outline");
  });
  return seen;
};

describe("pdfCommand · outline 报告值", () => {
  it("outline = 打印稿 heading 数（h1–h6 全算）", async () => {
    expect(await outlineOf(HEADINGS)).toBe(4);
  });

  it('无 heading 的文档：outline 是数字 0（不省键，不是 null / "0"）', async () => {
    expect(await outlineOf(PLAIN)).toStrictEqual(0);
  });
});

describe("pdfCommand · 大纲开关进到渲染层", () => {
  const seenOf = async (outline: boolean): Promise<boolean[]> => {
    const seen: boolean[] = [];
    await withDocOf(HEADINGS, async (dir) => {
      await pdfCommand(
        inputOf(dir, {
          outline,
          render: (input) => {
            seen.push(input.outline);
            return Promise.resolve({ bytes: Buffer.from(pdfOf(1)) });
          },
        }),
      );
    });
    return seen;
  };

  it("默认开：渲染层拿到的就是 outline: true", async () => {
    expect(await seenOf(true)).toEqual([true]);
  });

  it("--no-outline：渲染层收到 false，且报告 outline 为 0", async () => {
    expect(await seenOf(false)).toEqual([false]);
    expect(await outlineOf(HEADINGS, { outline: false })).toStrictEqual(0);
  });

  it("--no-outline --force：能覆盖已有文件，且报告 outline 仍为 0", async () => {
    await withDocOf(HEADINGS, async (dir) => {
      const out = join(dir, "out.pdf");
      writeFileSync(out, "old");
      const text = await pdfCommand(inputOf(dir, { out, force: true, outline: false, json: true }));
      expect(readFileSync(out, "latin1")).toContain("%PDF-");
      expect(fieldOfDataOf(text)("outline")).toStrictEqual(0);
    });
  });
});

describe("pdfCommand · 旗标互斥", () => {
  it("--outline 与 --no-outline 同传报 invalid_input，渲染没被调、也没落盘", () =>
    withDocOf(HEADINGS, async (dir) => {
      const out = join(dir, "out.pdf");
      const error = await failureOf(
        pdfCommand(
          inputOf(dir, {
            outlineConflict: true,
            // 真去渲染会以这个错误收场：把互斥校验挪到渲染之后，这条就会变着红。
            render: () => Promise.reject(new Error("--outline 与 --no-outline 不能同时使用")),
          }),
        ),
      );
      // 只钉错误码（exit 1 由「码 → 码表」一层决定），不钉人话文案。
      expect(error.code).toBe("invalid_input");
      expect(existsSync(out)).toBe(false);
    }));
});

describe("pdfHeadingsOf", () => {
  it("只数 h1–h6：h7 / h1x / 正文都不算", () => {
    expect(pdfHeadingsOf("<h1>a</h1><h5>b</h5><h6>c</h6>")).toBe(3);
    expect(pdfHeadingsOf("<h7>a</h7><h1x>b</h1x><p>c</p>")).toBe(0);
    expect(pdfHeadingsOf('<h1 id="x">a</h1>')).toBe(1);
  });

  it("数的是元素：注释里的 `<h1>`、文本里的 `<h1>` 都不算", () => {
    expect(pdfHeadingsOf("<article><!-- <h1>x</h1> --><h1>a</h1></article>")).toBe(1);
    expect(pdfHeadingsOf("<article><p>&lt;h1&gt;</p></article>")).toBe(0);
  });

  it("嵌套多深都算：不跟大纲的 `OUTLINE_DEPTH_LIMIT` 走（A14）", () => {
    const nested = [1, 2, 3, 4, 5, 6].reduceRight(
      (inner: string, level: number) =>
        `<h${String(level)}>L${String(level)}</h${String(level)}>${inner}`,
      "",
    );
    expect(pdfHeadingsOf(`<article>${nested}</article>`)).toBe(6);
  });
});
