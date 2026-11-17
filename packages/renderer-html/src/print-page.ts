// 这层管：封面 / 目录 / `<head>` 三段骨架的拼接与 4 MiB 预判；不读盘、不碰进程、不碰 DOM。

import { HrError } from "@hreader/core";

import { escapeAttribute, escapeText, utf8LengthOf } from "./markup";
import { PRINT_CSS } from "./print-css";
import type { TocEntry } from "./numbering";

const TOC_TITLE = "目录";

/** 锚名与条目成对出现：目录项和正文标题必须指向同一个锚，分开查表就多一条"查不到"的死分支。 */
export interface TocItem {
  readonly entry: TocEntry;
  readonly anchor: string;
}

/** 只在本模块内用：调用方按结构传字面量，导出反成一个没人 import 的名字（knip）。 */
interface PrintSheet {
  readonly title: string;
  readonly docId: string;
  readonly visualId: string;
  readonly themeCss: string;
  readonly bodyClass: string | undefined;
  readonly tocItems: readonly TocItem[];
  readonly tocIds: { readonly nav: string; readonly title: string };
  /** `<article>` 的开标签（属性已过滤并序列化好）：这一层不碰 DOM，只负责把它们拼起来。 */
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
 * 封面与目录标题都用 `<p>` 而非 `h1`/`h2`：产物里 `<h1..h6>` 的总数必须与 outline 的标题数逐条相等，
 * 多出来的这两个标题会把这个计数污染掉（AC-4）。
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
 * `</style` 在打印层先兜一层（§12.3）：CLI 的 `assertThemeSafe` 仍会拒绝并给 `invalid_theme`，
 * 这里只保证即使那股力量被绕过，主题也打不破 `<style>` 边界。`\/` 在 CSS 字符串里就是 `/`。
 */
const escapedThemeCssOf = (css: string): string => css.replaceAll(/<\/(style)/giu, "<\\/$1");

const headOf = (sheet: PrintSheet): readonly string[] => [
  "<head>",
  '<meta charset="utf-8">',
  `<meta name="hr-doc-id" content="${escapeAttribute(sheet.docId)}">`,
  `<meta name="hr-visual" content="${escapeAttribute(sheet.visualId)}">`,
  `<title>${escapeText(sheet.title)}</title>`,
  // 主题在前、骨架在后：两者特异度相同时**印刷骨架压主题**（物理层优先，§13.4）。
  `<style class="hr-theme">${escapedThemeCssOf(sheet.themeCss)}</style>`,
  `<style class="hr-print">${PRINT_CSS}</style>`,
  "</head>",
];

const bodyOpenOf = (bodyClass: string | undefined): string =>
  bodyClass === undefined || bodyClass === ""
    ? "<body>"
    : `<body class="${escapeAttribute(bodyClass)}">`;

/**
 * 4 MiB 上限（§11.4）：**产物最终字节数 > 4 MiB 才拒**，等于 4194304 是合格的（契约写的是 `>`）。
 * 在拼接前逐段累加 UTF-8 字节，超了就不分配整串；`reduce` 补上 `join("\n")` 的 `n-1` 个换行字节，
 * 所以这个数是**精确值**，不是上界——它与 `utf8LengthOf(返回值)` 恒等。
 * 不能拿 `part.length` 代替：CJK 一个码元 3 字节，"长度没超、字节超了"的稿子会被静默放行。
 */
const MAX_PRODUCT_BYTES = 4 * 1024 * 1024;

const productOf = (parts: readonly string[]): string => {
  const productBytes = parts.reduce((sum, part) => sum + utf8LengthOf(part), parts.length - 1);
  if (productBytes > MAX_PRODUCT_BYTES) {
    throw new HrError(
      "invalid_input",
      `打印稿 ${String(productBytes)} 字节，超过 4 MiB 上限（${String(MAX_PRODUCT_BYTES)}），拒绝拼接`,
    );
  }
  return parts.join("\n");
};

export const printSheetOf = (sheet: PrintSheet): string =>
  productOf([
    "<!DOCTYPE html>",
    '<html lang="zh-CN">',
    ...headOf(sheet),
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
