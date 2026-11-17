// 这层管：AC-5 / AC-6 的三条硬不变量在**真 Chrome** 上成立——①大纲条目数 = 打印稿 heading 数、
// ②每条 `/Dest` 经 `/Kids` 换算的页序与 heading 所在页一致、③同输入两次渲染的标题序列与页序相等。
//
// 规矩（与 `scripts/print-e2e.ts` 一致）：Chrome 缺失或 `HREADER_SKIP_CHROME=1` 时**打印** SKIPPED + 原因
// 再跳过——静默跳过等于假装跑过（§13），所以这里不用 `describe.skip` 的裸形式。
// oracle 一律走 `normalizeWhitespace`：夹具标题里刻意埋了换行与连续空格，退化成 `trim()` 就会红。

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseHtml } from "@hreader/core";
import { describe, expect, it } from "vitest";

// `normalizeWhitespace` 不在 `@hreader/core` 的公开导出面里（不为了一个测试 oracle 去扩它）：
// 跨包相对导入是仓里 `scripts/` 已有的做法，这里只用它的语义，不碰它的实现。
import { normalizeWhitespace } from "../../core/src/html/text.ts";
import { pdfHeadingsOf } from "../src/commands/pdf";
import { skipLineOf, skipReasonOf } from "../src/commands/printSkip";
import { pdfScanOf, type PdfOutlineNode } from "./helpers/pdf-scan";
import { expectNoAnsi, runCli, withTempDir } from "./harness";

type HtmlNode = ReturnType<typeof parseHtml>["root"];

const HEADING_TAGS: ReadonlySet<string> = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

const SYSTEM_CHROME = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

/**
 * 判定口径沿用 `printSkip.ts`：`CHROME_BIN` 传"探测结果"（`HREADER_CHROME` 是 CLI 的权威覆盖，
 * 给了就得存在，否则 CLI 会报 `chrome_missing`，这里跟着跳过没有意义）。
 */
const chromeFoundOf = (): string | undefined => {
  const override = process.env["HREADER_CHROME"];
  if (override !== undefined && override !== "") {
    return existsSync(override) ? override : undefined;
  }
  return SYSTEM_CHROME.find((path) => existsSync(path));
};

const SKIP_REASON = skipReasonOf({ ...process.env, CHROME_BIN: chromeFoundOf() ?? "" });
if (SKIP_REASON !== null) process.stdout.write(skipLineOf(SKIP_REASON));

/** 三章各占一页（`break-before: page`）：页序期望才定得死。标题里的空白是给归一用的。 */
const CHAPTERS: readonly string[] = ["第一章\n  晨读", "第二章   早餐", "第三章\n 复盘"];

const PARAGRAPHS: readonly string[] = Array.from(
  { length: 10 },
  (_unused: unknown, index: number) =>
    `<p>第 ${String(index + 1)} 段：撑出高度，确认分页真的发生。</p>`,
);

const docOf = (): string =>
  [
    "<!doctype html>",
    '<html lang="zh-CN"><head><meta charset="utf-8"><title>大纲不变量</title>',
    "<style>section { break-before: page; }</style></head><body>",
    '<article data-hr-id="doc">',
    `<h1 data-hr-id="hr-h0">${CHAPTERS[0] ?? ""}</h1>`,
    ...PARAGRAPHS,
    ...CHAPTERS.slice(1).flatMap((title, offset) => [
      `<section data-hr-id="hr-s${String(offset + 1)}">`,
      `<h2 data-hr-id="hr-h${String(offset + 1)}">${title}</h2>`,
      ...PARAGRAPHS,
      "</section>",
    ]),
    "</article></body></html>",
  ].join("\n");

const textOfNode = (node: HtmlNode): string => {
  if (node.kind === "text") return node.value;
  if (node.kind === "element" || node.kind === "document") {
    return node.children.map(textOfNode).join("");
  }
  return "";
};

/** `span.secnum` 是打印层亲生的编号：要剔掉，不然产物标题里就双重编号。 */
const isSecnumOf = (node: HtmlNode): boolean =>
  node.kind === "element" &&
  node.tag === "span" &&
  node.attrs.some(([name, value]) => name === "class" && value.includes("secnum"));

/**
 * 打印稿里 `h1–h6` 的文本，**按文档顺序**；与 `pdfHeadingsOf` 数的是同一批元素。
 */
const headingTextsOf = (html: string): readonly string[] => {
  const texts: string[] = [];
  const walk = (node: HtmlNode): void => {
    if (node.kind === "element" && HEADING_TAGS.has(node.tag)) {
      texts.push(
        node.children
          .filter((child) => !isSecnumOf(child))
          .map(textOfNode)
          .join(""),
      );
      return;
    }
    if (node.kind === "element" || node.kind === "document") node.children.forEach(walk);
  };
  walk(parseHtml(html).root);
  return texts;
};

const flattenOf = (nodes: readonly PdfOutlineNode[]): readonly PdfOutlineNode[] =>
  nodes.flatMap((node) => [node, ...flattenOf(node.children)]);

/** 标题 + 页序的比对形态：只比语义（归一后的标题、页序），不比字节。 */
const pairsOf = (nodes: readonly PdfOutlineNode[]): readonly string[] =>
  flattenOf(nodes).map((node) => `${normalizeWhitespace(node.title)} @${String(node.page)}`);

const stepOf = async (cwd: string, argv: readonly string[]): Promise<string> => {
  const result = await runCli(argv, { cwd });
  expectNoAnsi(result);
  if (result.code !== 0) throw new Error(`${argv.join(" ")} 失败：${result.stderr}`);
  return result.stdout;
};

describe.skipIf(SKIP_REASON !== null)("AC-5 / AC-6 · 真 Chrome 的大纲不变量", () => {
  it("should keep outline count, heading pages and repeat runs in step with the real PDF", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "source.html"), docOf());
      await stepOf(dir, ["export", "source.html", "--out", "print.html"]);
      const printed = readFileSync(join(dir, "print.html"), "utf8");
      const headings = headingTextsOf(printed);

      await stepOf(dir, ["pdf", "print.html", "--out", "one.pdf", "--json"]);
      await stepOf(dir, ["pdf", "print.html", "--out", "two.pdf", "--json"]);
      const one = pdfScanOf(readFileSync(join(dir, "one.pdf")));
      const two = pdfScanOf(readFileSync(join(dir, "two.pdf")));

      // ① 条数：产物里真有大纲，且与打印稿 heading 元素数一致（不是与某个计数器的返回值自洽）。
      expect(headings).toHaveLength(CHAPTERS.length);
      expect(pdfHeadingsOf(printed)).toBe(headings.length);
      expect(one.outline).toBeDefined();
      expect(flattenOf(one.outline ?? [])).toHaveLength(headings.length);

      // ② 标题与页序：产物标题 = 编号 + 打印稿标题文本（两边都归一后再比）；
      //   首章之前是打印层自己的前置页（目录），所以首章不一定是第 1 页；
      //   但 `break-before: page` 让每章各起一页，页序必须逐章 +1 且严格递增。
      const normalized = flattenOf(one.outline ?? []).map((node) =>
        normalizeWhitespace(node.title),
      );
      expect(normalized).toHaveLength(headings.length);
      headings.forEach((text, index) => {
        const tail = normalizeWhitespace(text);
        expect(normalized[index]?.endsWith(tail)).toBe(true);
        // 编号在前：退化成 `trim()` 时标题里的换行/连空格留着，上面那条会红。
        expect(normalized[index]?.length).toBeGreaterThan(tail.length);
      });
      const pages = flattenOf(one.outline ?? []).map((node) => node.page);
      expect(pages).toEqual(pages.map((_unused: number, index: number) => (pages[0] ?? 0) + index));

      // ③ 稳定性：同输入两次渲染，标题序列与页序相等（不断字节：PDF 里有时间戳/对象号）。
      expect(pairsOf(two.outline ?? [])).toEqual(pairsOf(one.outline ?? []));
    });
  }, 120_000);
});
