// 这层管：三条硬不变量在**真 Chrome** 上成立——①大纲条目数 = 打印稿 heading 数、
// ②每条 `/Dest` 经 `/Kids` 换算的页序与 heading 所在页一致、③同输入两次渲染的标题序列与页序相等。
//
// 规矩（与 `scripts/print-e2e.ts` 一致）：Chrome 缺失或 `HREADER_SKIP_CHROME=1` 时**打印** SKIPPED + 原因
// 再跳过——静默跳过等于假装跑过，所以这里不用 `describe.skip` 的裸形式。
// oracle 一律走 `normalizeWhitespace`：夹具标题里刻意埋了换行与连续空格，退化成 `trim()` 就会红。

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseHtml } from "@hreader/core";
import { describe, expect, it } from "vitest";

// `normalizeWhitespace` 不在 `@hreader/core` 的公开导出面里（不为了一个测试 oracle 去扩它）：
// 跨包相对导入是仓里 `scripts/` 已有的做法，这里只用它的语义，不碰它的实现。
import { normalizeWhitespace } from "../../core/src/html/text.ts";
import { skipLineOf, skipReasonOf } from "../src/commands/print-skip";
import { pdfScanOf, type PdfOutlineNode, type PdfScan } from "./helpers/pdf-scan";
import { expectNoAnsi, fieldOf, runCli, withTempDir } from "./harness";

type HtmlNode = ReturnType<typeof parseHtml>["root"];

const HEADING_TAGS: ReadonlySet<string> = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

const SYSTEM_CHROME = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

/**
 * 判定口径沿用 `print-skip.ts`：`CHROME_BIN` 传"探测结果"（`HREADER_CHROME` 是 CLI 的权威覆盖，
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
 * 打印稿里 `h1–h6` 的文本，**按文档顺序**。
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

/** `--json` 的 `data` 里取一个键：口径同 `pdf-command-outline.test.ts`，只取一个值。 */
const reportedOutlineOf = (text: string): unknown =>
  fieldOf(fieldOf(JSON.parse(text), "data"), "outline");

/**
 * ① 条数四方对照：`--json.outline`（= `src/pdf/bookmarks.ts` 的返回值）、产物内实走条目数、
 * 大纲根自报的 `/Count`、打印稿 `h1–h6` 元素数；后三者是测试侧的独立 oracle。
 */
const expectCountOf = (reported: unknown, scan: PdfScan, headings: readonly string[]): void => {
  const walked = flattenOf(scan.outline ?? []).length;
  expect(headings).toHaveLength(CHAPTERS.length);
  expect(scan.outline).toBeDefined();
  expect(walked).toBe(headings.length);
  expect(reported).toBe(walked);
  // 根对象没有 `/Count` 时 `outlineCount` 是 `undefined`：`?? 0` 会让"缺键"悄悄变成"0 条也通过"。
  expect(scan.outlineCount).toBeDefined();
  if (scan.outlineCount === undefined) throw new Error("大纲根对象没有 /Count");
  expect(Math.abs(scan.outlineCount)).toBe(walked);
};

/** `--json.outline` 是条目数（数字），不是树：树只在 oracle 与 `--json` 的另一路里。 */
const reportedCountOf = (text: string): number => {
  const outline = reportedOutlineOf(text);
  if (typeof outline !== "number") throw new Error("--json 的 data.outline 不是数字");
  return outline;
};

/**
 * ② 标题与页序：产物标题 = 编号 + 打印稿标题文本（两边都归一后再比）。首章之前是打印层自己的
 * 前置页（目录），所以首章不一定是第 1 页；但 `break-before: page` 让每章各起一页，页序必须逐章 +1。
 */
const expectHeadingsOf = (nodes: readonly PdfOutlineNode[], headings: readonly string[]): void => {
  const flattened = flattenOf(nodes);
  expect(flattened).toHaveLength(headings.length);
  flattened.forEach((node, index) => {
    const tail = normalizeWhitespace(headings[index] ?? "");
    // 退化成 `trim()` 时标题里的换行/连空格留着：`endsWith` 与“更长”两条会一起红。
    expect(normalizeWhitespace(node.title).endsWith(tail)).toBe(true);
    expect(normalizeWhitespace(node.title).length).toBeGreaterThan(tail.length);
  });
  const pages = flattened.map((node) => node.page);
  expect(pages).toEqual(pages.map((_unused: number, index: number) => (pages[0] ?? 0) + index));
};

const stepOf = async (cwd: string, argv: readonly string[]): Promise<string> => {
  const result = await runCli(argv, { cwd, timeoutMs: 60_000 });
  expectNoAnsi(result);
  if (result.code !== 0) throw new Error(`${argv.join(" ")} 失败：${result.stderr}`);
  return result.stdout;
};

/** 测试员给的复现：`<h1>endobj</h1><p>x</p><h1>Second</h1>`——无恶意的合法文档。 */
const REPRO_HTML = [
  "<!doctype html>",
  '<html lang="zh-CN"><head><meta charset="utf-8"><title>复现</title></head><body>',
  '<article data-hr-id="doc">',
  '<h1 data-hr-id="hr-h0">endobj</h1>',
  "<p>x</p>",
  '<h1 data-hr-id="hr-h1">Second</h1>',
  "</article></body></html>",
].join("\n");

/**
 * 标题字面量里写满 PDF 结构（`endobj`、`/First 99 0 R`、`/Next 77 0 R`、`%`、括号嵌套、`\\)`）：
 * Chrome 会把标题原样写进 `/Title`，结构扫描必须在字面串里止步。`<<` 用实体，免得被当成标签。
 */
const HOSTILE_HTML = [
  "<!doctype html>",
  '<html lang="zh-CN"><head><meta charset="utf-8"><title>结构陷阱</title></head><body>',
  '<article data-hr-id="doc">',
  '<h1 data-hr-id="hr-h0">endobj</h1>',
  '<h1 data-hr-id="hr-h1">/First 99 0 R /Next 77 0 R /Count 999</h1>',
  '<h1 data-hr-id="hr-h2">50% trailer &lt;&lt; /Root 98 0 R &gt;&gt; (嵌套 (括号)) 反斜杠 \\ 与 \\)</h1>',
  "</article></body></html>",
].join("\n");

/** 渲染一份文档并读出 `--json.outline` 的条目数：`pdf` 失败（含 `render_empty`）这里就会抛。 */
const writtenCountOf = async (html: string, name: string): Promise<number> => {
  let count = -1;
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "source.html"), html);
    await stepOf(dir, ["export", "source.html", "--out", "print.html"]);
    count = reportedCountOf(await stepOf(dir, ["pdf", "print.html", "--out", name, "--json"]));
    expect(existsSync(join(dir, name))).toBe(true);
  }, 120_000);
  return count;
};

describe.skipIf(SKIP_REASON !== null)("真 Chrome 的大纲不变量", () => {
  it("should keep outline count, heading pages and repeat runs in step with the real PDF", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "source.html"), docOf());
      await stepOf(dir, ["export", "source.html", "--out", "print.html"]);
      const printed = readFileSync(join(dir, "print.html"), "utf8");
      const headings = headingTextsOf(printed);

      const oneText = await stepOf(dir, ["pdf", "print.html", "--out", "one.pdf", "--json"]);
      await stepOf(dir, ["pdf", "print.html", "--out", "two.pdf", "--json"]);
      const one = pdfScanOf(readFileSync(join(dir, "one.pdf")));
      const two = pdfScanOf(readFileSync(join(dir, "two.pdf")));

      expectCountOf(reportedOutlineOf(oneText), one, headings);
      expectHeadingsOf(one.outline ?? [], headings);

      // ③ 稳定性：同输入两次渲染，标题序列与页序相等（不断字节：PDF 里有时间戳/对象号）。
      expect(pairsOf(two.outline ?? [])).toEqual(pairsOf(one.outline ?? []));
    }, 120_000);
  }, 120_000);

  it("should count bookmarks whose title is the literal endobj", async () => {
    expect(await writtenCountOf(REPRO_HTML, "repro.pdf")).toBe(2);
  }, 120_000);

  it("should count bookmarks whose titles look like PDF structure", async () => {
    expect(await writtenCountOf(HOSTILE_HTML, "hostile.pdf")).toBe(3);
  }, 120_000);
});
