// 这层管：AC-6 的出版级打印规则（纯字符串常量）；不选主题、不拼文档、不读盘。

/**
 * 选择器成对写：产物用的是 `.cover`/`.toc`/`section.chapter`（AC-4 钉死 `section.chapter`），
 * 别名只有四个——`.print-cover`/`.print-cover__title`/`.print-toc`/`.print-chapter`，给手写模板与主题复用。
 * 成对的两个名字必须同时生效，否则改了类名就静默丢版式（§6「规则存在 ≠ 规则生效」的另一种死法）。
 * 别名**不补齐**：产物不走 `.print-*`，多写一份 `.print-toc__item--h*` 只是没人读的第二份真源（§13.5）。
 * `page-break-*` 与 `break-*` 成对保留：前者覆盖老印刷引擎，后者是现行标准。
 */
export const PRINT_CSS = `@page {
  size: A4;
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
