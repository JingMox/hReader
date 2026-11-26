// 这层管：出版级打印规则（纯字符串常量）；不选主题、不拼文档、不读盘。

import { HrError } from "@hreader/core";

/** 纸张三档与 `hr pdf --page-size` 同一套名字；CSS 关键字大小写不敏感，写惯用形式。 */
export type PaperSize = "a4" | "letter" | "a5";

const PAPER_KEYWORD: Readonly<Record<PaperSize, string>> = {
  a4: "A4",
  letter: "letter",
  a5: "A5",
};

/**
 * 选择器成对写：产物用的是 `.cover`/`.toc`/`section.chapter`，
 * 别名只有四个——`.print-cover`/`.print-cover__title`/`.print-toc`/`.print-chapter`，给手写模板与主题复用。
 * 成对的两个名字必须同时生效，否则改了类名就静默丢版式（"规则存在 ≠ 规则生效"的另一种死法）。
 * 别名**不补齐**：产物不走 `.print-*`，多写一份 `.print-toc__item--h*` 只是没人读的第二份真源。
 * `page-break-*` 与 `break-*` 成对保留：前者覆盖老印刷引擎，后者是现行标准。
 *
 * `@page` 的纸张必须随 `--page-size` 变：只换 printToPDF 的纸不换版心，正文会按 A4 宽排再被纸边切掉。
 * a4 的内容与既有产物逐字节一致（快照/字节断言钉死），其余两档只改 `size` 关键字。
 */
const PRINT_CSS_TEMPLATE = `@page {
  size: @@paper@@;
  margin: 20mm 18mm;
}
@page :first {
  margin: 0;
}
:root {
  color-scheme: light;
}
body {
  background: #fff;
  color: #1a1a1a;
  font-family: "Songti SC", "Source Han Serif SC", "Noto Serif CJK SC", "Noto Sans CJK SC", serif;
  font-size: 11pt;
  line-height: 1.75;
  /* 打印稿没有交互，字距/字距微调交给字体本身。 */
  text-rendering: optimizeLegibility;
}
h1,
h2,
h3,
h4 {
  break-after: avoid;
  page-break-after: avoid;
  line-height: 1.35;
  margin: 1.4em 0 0.6em;
}
h1 {
  font-size: 22pt;
}
h2 {
  font-size: 16pt;
}
h3 {
  font-size: 13pt;
}
h4 {
  font-size: 11.5pt;
}
p {
  widows: 3;
  orphans: 3;
  margin: 0 0 0.85em;
}
a {
  color: inherit;
  text-decoration: underline;
  text-decoration-thickness: 0.5pt;
  text-underline-offset: 0.15em;
}
a[href^="http"]::after {
  content: " (" attr(href) ")";
  overflow-wrap: anywhere;
  text-decoration: none;
  color: #555;
  font-size: 9pt;
}
pre,
code {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  font-size: 9.5pt;
}
pre {
  border: 0.5pt solid #d0d0d0;
  padding: 6pt 8pt;
}
blockquote {
  margin: 1em 0;
  padding-left: 10pt;
  border-left: 2pt solid #d0d0d0;
  color: #444;
}
table {
  border-collapse: collapse;
  width: 100%;
  font-size: 10pt;
}
th,
td {
  border: 0.5pt solid #8a8a8a;
  padding: 3pt 5pt;
  text-align: left;
  vertical-align: top;
}
thead {
  display: table-header-group;
}
tr,
img,
figure,
table {
  break-inside: avoid;
  page-break-inside: avoid;
}
img {
  max-width: 100%;
  height: auto;
}
.cover,
.print-cover {
  break-after: page;
  page-break-after: always;
  padding: 40mm 18mm;
  text-align: center;
}
.cover__title,
.print-cover__title {
  font-size: 26pt;
  line-height: 1.3;
  margin: 0;
}
.toc,
.print-toc {
  break-after: page;
  page-break-after: always;
}
.toc__title {
  font-size: 18pt;
  margin: 0 0 1em;
}
.toc__list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.toc__item {
  margin: 0.2em 0;
}
.toc__link {
  display: flex;
  align-items: baseline;
  color: inherit;
  text-decoration: none;
}
/* 点导引线：伪元素当弹性填充，长标题换行也不会把点线挤歪。 */
.toc__link::after {
  content: "";
  flex: 1 1 auto;
  margin: 0 0.4em;
  border-bottom: 0.5pt dotted currentColor;
  opacity: 0.45;
}
.toc__num {
  min-width: 2.5em;
  font-variant-numeric: tabular-nums;
}
.toc__item--h2 .toc__link {
  padding-left: 1.2em;
}
.toc__item--h3 .toc__link {
  padding-left: 2.4em;
}
.toc__item--h4 .toc__link {
  padding-left: 3.6em;
}
section.chapter,
.print-chapter {
  break-before: page;
  page-break-before: always;
}
.secnum {
  margin-right: 0.4em;
  font-variant-numeric: tabular-nums;
}
article > section.chapter:first-child,
article > .print-chapter:first-child {
  break-before: auto;
  page-break-before: auto;
}
@media print {
  :root {
    color-scheme: light;
  }
  body {
    background: #fff;
    color: #1a1a1a;
  }
}
`;

/**
 * slides 形态的骨架：纸张尺寸本身就是契约（横版 16:9 一页一屏），不走 `--page-size` 三档。
 * 没有封面与目录页，每个顶层 slide 元素一条强制分页；版式细节仍归主题（骨架只保底分页）。
 * `@page` 的 margin 只在主题没声明命名页时生效：主题写 `page: hr-slide` + `@page hr-slide`
 * 时命名页整体接管，0.5in 这里只是无主题 slides 的兜底余白。
 */
const SLIDES_PRINT_CSS = `@page {
  size: 13.333in 7.5in;
  margin: 0.5in;
}
:root {
  color-scheme: light;
}
body {
  margin: 0;
}
article > h1,
article > section {
  break-after: page;
  page-break-after: always;
}
`;

const PAPER_TOKEN = "@@paper@@";

/**
 * `paper` 在类型层已收窄，但 CLI 的字符串会原样流到这里：不守卫就会产出 `size: undefined;` 这种
 * 印刷引擎默默当 A4 用的坏 CSS，错误必须在生成阶段就炸出来。按 `string` 索引查询就是
 * 把“运行期可能是任意字符串”这件事写进类型，否则守卫在类型检查器眼里是不可达代码。
 */
const PAPER_KEYWORD_BY_NAME: Record<string, string | undefined> = PAPER_KEYWORD;

const paperKeywordOf = (paper: PaperSize): string => {
  const keyword = PAPER_KEYWORD_BY_NAME[paper];
  if (keyword === undefined) {
    throw new HrError("invalid_input", `纸张只能是 a4 | letter | a5：${paper}`);
  }
  return keyword;
};

export const printCssOf = (paper: PaperSize): string =>
  PRINT_CSS_TEMPLATE.replace(PAPER_TOKEN, paperKeywordOf(paper));

export const PRINT_CSS = printCssOf("a4");

/** slides 打印稿的骨架 CSS：常量不是模板——slides 纸张不接受 `--page-size` 参数化。 */
export const slidesPrintCssOf = (): string => SLIDES_PRINT_CSS;
