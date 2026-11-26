// Assembles the cover / TOC / `<head>` skeleton and pre-checks the 4 MiB budget; no disk, no process, no DOM.

import { HrError } from "@hreader/core";

import { escapeAttribute, escapeText, utf8LengthOf } from "./markup";
import { printCssOf, slidesPrintCssOf } from "./print-css";
import type { PaperSize } from "./print-css";
import type { TocEntry } from "./numbering";

const TOC_TITLE = "目录";

/** Anchor and entry come in pairs: a TOC item and its body heading must resolve to the same anchor, and separate lookups would add a dead "not found" branch. */
export interface TocItem {
  readonly entry: TocEntry;
  readonly anchor: string;
}

/** Module-local only: callers pass structural literals, and exporting it would just be a name nobody imports (knip). */
interface PrintSheet {
  readonly paper: PaperSize;
  readonly title: string;
  readonly docId: string;
  readonly visualId: string;
  readonly themeCss: string;
  readonly bodyClass: string | undefined;
  readonly tocItems: readonly TocItem[];
  readonly tocIds: { readonly nav: string; readonly title: string };
  /** Opening tag of `<article>` (attributes already filtered and serialized): this layer touches no DOM, it only concatenates. */
  readonly articleOpen: string;
  readonly body: string;
}

const tocItemOf = (item: TocItem): string =>
  [
    `<li class="toc__item toc__item--h${String(item.entry.level)}" data-toc-id="${escapeAttribute(item.entry.id)}">`,
    `<a class="toc__link" href="#${escapeAttribute(item.anchor)}">`,
    `<span class="toc__num">${escapeText(item.entry.number)}</span> ${escapeText(item.entry.text)}`,
    "</a></li>",
  ].join("");

/**
 * Cover and TOC titles use `<p>`, not `h1`/`h2`: the product's total `<h1..h6>` count must equal the outline's
 * heading count one for one, and two extra headings would pollute that count.
 */
const coverOf = (title: string): readonly string[] => [
  '<header class="cover">',
  `<p class="cover__title">${escapeText(title)}</p>`,
  "</header>",
];

const tocOf = (
  items: readonly TocItem[],
  ids: { readonly nav: string; readonly title: string },
): readonly string[] => [
  `<nav class="toc" id="${ids.nav}">`,
  `<p class="toc__title" id="${ids.title}">${TOC_TITLE}</p>`,
  '<ul class="toc__list">',
  ...items.map((item) => tocItemOf(item)),
  "</ul>",
  "</nav>",
];

/**
 * `</style` gets a first net here in the print layer: the CLI's `assertThemeSafe` still rejects with `invalid_theme`,
 * and this only guarantees that even if that check were bypassed, a theme cannot break the `<style>` boundary. `\/` is just `/` inside a CSS string.
 */
const escapedThemeCssOf = (css: string): string => css.replaceAll(/<\/(style)/giu, "<\\/$1");

const headOf = (sheet: PrintSheet, printCss: string): readonly string[] => [
  "<head>",
  '<meta charset="utf-8">',
  `<meta name="hr-doc-id" content="${escapeAttribute(sheet.docId)}">`,
  `<meta name="hr-visual" content="${escapeAttribute(sheet.visualId)}">`,
  `<title>${escapeText(sheet.title)}</title>`,
  // Theme first, skeleton second: at equal specificity the **print skeleton beats the theme** (the physical layer wins).
  `<style class="hr-theme">${escapedThemeCssOf(sheet.themeCss)}</style>`,
  `<style class="hr-print">${printCss}</style>`,
  "</head>",
];

const bodyOpenOf = (bodyClass: string | undefined): string =>
  bodyClass === undefined || bodyClass === ""
    ? "<body>"
    : `<body class="${escapeAttribute(bodyClass)}">`;

/**
 * 4 MiB limit: reject only when the product's final byte count is **> 4 MiB**; exactly 4194304 passes (the contract says `>`).
 * UTF-8 bytes are accumulated per part before assembly, so an oversized product never allocates the joined string; `reduce` adds the `n-1` newline bytes of `join("\n")`,
 * making this an **exact** figure, not an upper bound — identical to `utf8LengthOf(return value)`.
 * `part.length` cannot stand in: a CJK code unit costs 3 bytes, so a sheet "under the limit in length but over in bytes" would slip through silently.
 */
const MAX_PRODUCT_BYTES = 4 * 1024 * 1024;

const productOf = (parts: readonly string[]): string => {
  const productBytes = parts.reduce((sum, part) => sum + utf8LengthOf(part), parts.length - 1);
  if (productBytes > MAX_PRODUCT_BYTES) {
    throw new HrError(
      "invalid_input",
      `打印稿 ${String(productBytes)} 字节，超过 4 MiB 上限（${String(MAX_PRODUCT_BYTES)}），拒绝拼接；按章拆分文档，单篇控制在 4 MiB 以内再导出`,
    );
  }
  return parts.join("\n");
};

export const printSheetOf = (sheet: PrintSheet): string =>
  productOf([
    "<!DOCTYPE html>",
    '<html lang="zh-CN">',
    ...headOf(sheet, printCssOf(sheet.paper)),
    bodyOpenOf(sheet.bodyClass),
    ...coverOf(sheet.title),
    ...tocOf(sheet.tocItems, sheet.tocIds),
    sheet.articleOpen,
    sheet.body,
    "</article>",
    "</body>",
    "</html>",
    "",
  ]);

/**
 * Slides form: no cover or TOC (the title page is the first h1; two extra pages would break the "page count = slide count" promise).
 * Pagination uses the slides-specific CSS — paper is fixed 16:9 and `sheet.paper` has no effect on this path.
 */
export const slidesSheetOf = (sheet: PrintSheet): string =>
  productOf([
    "<!DOCTYPE html>",
    '<html lang="zh-CN">',
    ...headOf(sheet, slidesPrintCssOf()),
    bodyOpenOf(sheet.bodyClass),
    sheet.articleOpen,
    sheet.body,
    "</article>",
    "</body>",
    "</html>",
    "",
  ]);
