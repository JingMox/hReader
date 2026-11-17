import { describe, expect, it } from "vitest";

import { PRINT_CSS } from "../src/index";

/** 空白归一化后再比对规则体：格式化改动（缩行、换行）不该弄红规则级测试。 */
const flat = PRINT_CSS.replaceAll(/\s+/gu, " ");

const has = (declarations: readonly string[]): boolean =>
  declarations.every((declaration) => flat.includes(declaration));

interface RuleCase {
  readonly name: string;
  readonly selector: string;
  readonly body: readonly string[];
}

/** AC-6 逐条（卡 §6：规则"存在"由单测钉，"生效"必须真 Chrome）。 */
const RULE_CASES: readonly RuleCase[] = [
  { name: "A4 纸与页边距", selector: "@page {", body: ["size: A4;", "margin: 20mm 18mm;"] },
  { name: "首页无边距", selector: "@page :first {", body: ["margin: 0;"] },
  { name: "标题不断行在页尾", selector: "h1, h2, h3, h4 {", body: ["break-after: avoid;"] },
  { name: "表头重复", selector: "thead {", body: ["display: table-header-group;"] },
  {
    name: "块级不断裂",
    selector: "tr, img, figure, table {",
    body: ["break-inside: avoid;"],
  },
  { name: "段落孤行控制", selector: "p {", body: ["widows: 3;", "orphans: 3;"] },
  {
    name: "超链接括注 URL",
    selector: 'a[href^="http"]::after {',
    body: ['content: " (" attr(href) ")";'],
  },
  {
    name: "代码不断词",
    selector: "pre, code {",
    body: ["white-space: pre-wrap;", "overflow-wrap: anywhere;"],
  },
  {
    name: "章节起新页",
    selector: "section.chapter, .print-chapter {",
    body: ["break-before: page;"],
  },
  { name: "封面后分页", selector: ".cover, .print-cover {", body: ["break-after: page;"] },
  { name: "目录后分页", selector: ".toc, .print-toc {", body: ["break-after: page;"] },
  { name: "打印强制浅色", selector: "@media print {", body: [":root {", "color-scheme: light;"] },
];

const declarationsOf = (selector: string): string => {
  const start = flat.indexOf(selector);
  if (start === -1) {
    throw new Error(`PRINT_CSS 里没有选择器：${selector}`);
  }
  const open = flat.indexOf("{", start);
  return flat.slice(open, flat.indexOf("}", open));
};

describe("AC-6 出版级规则存在", () => {
  it.each(RULE_CASES.map((item) => [item.name, item] as const))("%s", (_name, item) => {
    expect(flat).toContain(item.selector);
    const body = declarationsOf(item.selector);
    expect(item.body.filter((declaration) => !body.includes(declaration))).toEqual([]);
  });

  it("层级字号单调递减（h1 > h2 > h3 > h4）", () => {
    const sizeOf = (selector: string): number =>
      Number(/font-size: ([\d.]+)pt/u.exec(declarationsOf(selector))?.[1] ?? "0");
    const sizes = ["h1 {", "h2 {", "h3 {", "h4 {"].map(sizeOf);
    expect(sizes).toEqual([...sizes].sort((left, right) => right - left));
    expect(new Set(sizes).size).toBe(4);
  });

  it("中文字体栈覆盖衬线中文与等宽拉丁", () => {
    expect(flat).toContain('"Songti SC"');
    expect(flat).toContain('"Source Han Serif SC"');
    expect(flat).toContain("ui-monospace");
  });

  it("TOC 层级缩进递增、标题行有点导引线", () => {
    const indentOf = (selector: string): number =>
      Number(/padding-left: ([\d.]+)em/u.exec(declarationsOf(selector))?.[1] ?? "0");
    const indents = [
      ".toc__item--h2 .toc__link {",
      ".toc__item--h3 .toc__link {",
      ".toc__item--h4 .toc__link {",
    ].map(indentOf);
    expect(indents).toEqual([...indents].sort((left, right) => left - right));
    expect(declarationsOf(".toc__link::after {")).toContain("border-bottom");
  });

  it("表格有实线边框、图片不溢出", () => {
    expect(declarationsOf("th, td {")).toContain("border: 0.5pt solid");
    expect(declarationsOf("img {")).toContain("max-width: 100%;");
  });
});

describe("AC-2 / §4 约束", () => {
  it("≤ 8 KiB", () => {
    expect(Buffer.byteLength(PRINT_CSS, "utf8")).toBeLessThanOrEqual(8192);
  });

  it("零外部引用：无 @import、无 url()", () => {
    expect(PRINT_CSS).not.toContain("@import");
    expect(PRINT_CSS).not.toContain("url(");
  });

  it("骨架只认类名与标签，不写死文档专有 id", () => {
    expect(PRINT_CSS).not.toContain("#hr-");
  });

  it("两套类名成对生效（产物用 .cover/.toc，模板用 .print-*）", () => {
    expect(has([".cover", ".print-cover"])).toBe(true);
    expect(has([".toc", ".print-toc"])).toBe(true);
  });
});
