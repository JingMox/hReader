// 这层管：`hr pdf` 的大纲语义（默认开 / 报告值 / 互斥）；渲染层用假 render 注入，不起 Chrome。
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { HrError } from "@hreader/core";
import { describe, expect, it } from "vitest";

import { pdfCommand, type PdfCommandInput, type RenderPdf } from "../src/commands/pdf";
import { pdfOf } from "./chrome-helpers";
import {
  bytesOf,
  OUTLINE_COUNT_LIE,
  pagesOf,
  pdfWithBookmarksOf,
  withOutlinesOf,
} from "./helpers/pdf-fixtures";
import { fieldOf, withTempDir } from "./harness";

/** 打印稿里的 heading 数（4）与产物书签数刻意不等：报告值只许来自产物。 */
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
  visual: "atelier-editorial",
  out: join(dir, "out.pdf"),
  force: false,
  workspace: dir,
  json: false,
  warn: () => undefined,
  render: (input) => Promise.resolve({ bytes: pdfWithBookmarksOf(input.outline ? 2 : 0) }),
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
  it("outline = 产物里的大纲条目数（不是打印稿的 heading 数）", async () => {
    const render = (): Promise<{ bytes: Uint8Array }> =>
      Promise.resolve({ bytes: pdfWithBookmarksOf(3) });
    expect(await outlineOf(HEADINGS, { render })).toBe(3);
  });

  it('产物没有 /Outlines 时：outline 是数字 0（不省键，不是 null / "0"）', async () => {
    expect(
      await outlineOf(HEADINGS, {
        render: () => Promise.resolve({ bytes: pdfWithBookmarksOf(0) }),
      }),
    ).toStrictEqual(0);
  });

  it("产物大纲结构自相矛盾：render_empty，且不落盘", () =>
    withDocOf(HEADINGS, async (dir) => {
      const out = join(dir, "out.pdf");
      // `/Count 3` 但只有 2 条：走的是 `bookmarkCountOf` 的交叉核对，不是命令层的任何判断。
      const bytes = bytesOf(withOutlinesOf(pagesOf(1)) + OUTLINE_COUNT_LIE);
      const error = await failureOf(
        pdfCommand(inputOf(dir, { out, render: () => Promise.resolve({ bytes }) })),
      );
      expect(error.code).toBe("render_empty");
      expect(existsSync(out)).toBe(false);
    }));
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

describe("pdfCommand · 报告值只来自产物", () => {
  it("`PLAIN` 文档配上带书签的产物：报的仍是产物数（打印稿不参与）", async () => {
    expect(await outlineOf(PLAIN)).toBe(2);
  });
});

describe("pdfCommand · 人读行", () => {
  it("人读行是 `<path> (N 页, M 条书签)`，M 与 `--json.outline` 同值", () =>
    withDocOf(HEADINGS, async (dir) => {
      const out = join(dir, "out.pdf");
      const human = await pdfCommand(inputOf(dir, { out, force: true }));
      const json = await pdfCommand(inputOf(dir, { out, force: true, json: true }));
      expect(human).toBe(`${out} (1 页, 2 条书签)\n`);
      expect(fieldOfDataOf(json)("outline")).toBe(2);
    }));

  it("--no-outline 的人读行仍然印 `0 条书签`（M 不省）", () =>
    withDocOf(HEADINGS, async (dir) => {
      const out = join(dir, "out.pdf");
      expect(await pdfCommand(inputOf(dir, { out, outline: false }))).toBe(
        `${out} (1 页, 0 条书签)\n`,
      );
    }));
});
