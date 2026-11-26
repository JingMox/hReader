// This layer covers three hard invariants on **real Chrome** — ① outline entry count = printout heading count,
// ② each `/Dest`'s page order via `/Kids` matches the page its heading is on, ③ two renders of the same input give equal title sequences and page orders.
//
// The rule (same as `scripts/print-e2e.ts`): with Chrome missing or `HREADER_SKIP_CHROME=1`, **print** SKIPPED +
// the reason, then skip — a silent skip fakes a run, so no bare `describe.skip` here.
// The oracle always goes through `normalizeWhitespace`: fixture titles deliberately bury newlines and runs of spaces — degrade to `trim()` and it goes red.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseHtml } from "@hreader/core";
import { describe, expect, it } from "vitest";

// `normalizeWhitespace` is not on `@hreader/core`'s public export surface (no widening it for one test oracle):
// cross-package relative import is what `scripts/` already does in this repo; only its semantics are used, its implementation untouched.
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
 * The judgment follows `print-skip.ts`: `CHROME_BIN` carries "the probe result" (`HREADER_CHROME` is the CLI's
 * authoritative override — given, it must exist, or the CLI reports `chrome_missing` and skipping here is pointless).
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

/** Three chapters, one page each (`break-before: page`): page-order expectations must be pinned. Whitespace in titles feeds normalization. */
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

/** `span.secnum` is the print layer's own numbering: strip it or artifact titles end up double-numbered. */
const isSecnumOf = (node: HtmlNode): boolean =>
  node.kind === "element" &&
  node.tag === "span" &&
  node.attrs.some(([name, value]) => name === "class" && value.includes("secnum"));

/**
 * The printout's `h1–h6` texts, **in document order**.
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

/** The comparison shape of title + page order: only semantics (normalized titles, page order), never bytes. */
const pairsOf = (nodes: readonly PdfOutlineNode[]): readonly string[] =>
  flattenOf(nodes).map((node) => `${normalizeWhitespace(node.title)} @${String(node.page)}`);

/** Read one key out of `--json`'s `data`: same rule as `pdf-command-outline.test.ts`, one value only. */
const reportedOutlineOf = (text: string): unknown =>
  fieldOf(fieldOf(JSON.parse(text), "data"), "outline");

/**
 * ① Four-way count check: `--json.outline` (= `src/pdf/bookmarks.ts`'s return), the walked entry count inside
 * the artifact, the outline root's self-reported `/Count`, and the printout `h1–h6` element count; the last
 * three are independent test-side oracles.
 */
const expectCountOf = (reported: unknown, scan: PdfScan, headings: readonly string[]): void => {
  const walked = flattenOf(scan.outline ?? []).length;
  expect(headings).toHaveLength(CHAPTERS.length);
  expect(scan.outline).toBeDefined();
  expect(walked).toBe(headings.length);
  expect(reported).toBe(walked);
  // With no `/Count` on the root, `outlineCount` is `undefined`: `?? 0` would quietly turn "missing key" into "0 entries also pass".
  expect(scan.outlineCount).toBeDefined();
  if (scan.outlineCount === undefined) throw new Error("the outline root has no /Count");
  expect(Math.abs(scan.outlineCount)).toBe(walked);
};

/** `--json.outline` is the entry count (a number), not the tree: the tree only lives in the oracle and another `--json` route. */
const reportedCountOf = (text: string): number => {
  const outline = reportedOutlineOf(text);
  if (typeof outline !== "number") throw new Error("--json data.outline is not a number");
  return outline;
};

/**
 * ② Titles and page order: artifact title = numbering + printout heading text (both sides normalized before
 * comparing). Ahead of chapter one sits the print layer's own front matter (TOC), so the first chapter is not
 * necessarily page 1; but `break-before: page` gives each chapter its own page — page order must step +1 per chapter.
 */
const expectHeadingsOf = (nodes: readonly PdfOutlineNode[], headings: readonly string[]): void => {
  const flattened = flattenOf(nodes);
  expect(flattened).toHaveLength(headings.length);
  flattened.forEach((node, index) => {
    const tail = normalizeWhitespace(headings[index] ?? "");
    // Degraded to `trim()`, newlines/space-runs inside titles survive: `endsWith` and "is longer" both go red.
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

/** Repro input: `<h1>endobj</h1><p>x</p><h1>Second</h1>` — a benign, legal document. */
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
 * Title literals full of PDF structure (`endobj`, `/First 99 0 R`, `/Next 77 0 R`, `%`, nested parens, `\)`):
 * Chrome writes titles verbatim into `/Title`, so structure scanning must stop inside literal strings. `<<` uses entities so it is not mistaken for a tag.
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

/** Render one document and read `--json.outline`'s entry count: a `pdf` failure (`render_empty` included) throws right here. */
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

describe.skipIf(SKIP_REASON !== null)("outline invariants on real Chrome", () => {
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

      // ③ Stability: two renders of the same input give equal title sequences and page orders (not bytes — PDFs carry timestamps/object numbers).
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
