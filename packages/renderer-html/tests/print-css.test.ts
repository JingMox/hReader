import { describe, expect, it } from "vitest";

import { HrError } from "@hreader/core";

import { PRINT_CSS } from "../src/index";
import { printCssOf, slidesPrintCssOf } from "../src/print-css";

/** Rule bodies are compared after whitespace normalization: reformatting (line joins, wraps) must not redden rule-level tests. */
const flat = PRINT_CSS.replaceAll(/\s+/gu, " ");

const has = (declarations: readonly string[]): boolean =>
  declarations.every((declaration) => flat.includes(declaration));

interface RuleCase {
  readonly name: string;
  readonly selector: string;
  readonly body: readonly string[];
}

/** Pins each publication-grade rule's existence; "does it take effect" needs real Chrome. */
const RULE_CASES: readonly RuleCase[] = [
  { name: "A4 paper and margins", selector: "@page {", body: ["size: A4;", "margin: 20mm 18mm;"] },
  { name: "first page has no margin", selector: "@page :first {", body: ["margin: 0;"] },
  { name: "h1-h4 keep with next", selector: "h1, h2, h3, h4 {", body: ["break-after: avoid;"] },
  { name: "repeating table header", selector: "thead {", body: ["display: table-header-group;"] },
  {
    name: "unbreakable block-level boxes",
    selector: "tr, img, figure, table {",
    body: ["break-inside: avoid;"],
  },
  { name: "widow and orphan control", selector: "p {", body: ["widows: 3;", "orphans: 3;"] },
  {
    name: "hyperlink URL shown in parentheses",
    selector: 'a[href^="http"]::after {',
    body: ['content: " (" attr(href) ")";'],
  },
  {
    name: "code avoids word breaking",
    selector: "pre, code {",
    body: ["white-space: pre-wrap;", "overflow-wrap: anywhere;"],
  },
  {
    name: "chapter starts on a new page",
    selector: "section.chapter, .print-chapter {",
    body: ["break-before: page;"],
  },
  { name: "break after cover", selector: ".cover, .print-cover {", body: ["break-after: page;"] },
  { name: "break after the TOC", selector: ".toc, .print-toc {", body: ["break-after: page;"] },
  { name: "light printing", selector: "@media print {", body: [":root {", "color-scheme: light;"] },
];

const declarationsOf = (selector: string): string => {
  const start = flat.indexOf(selector);
  if (start === -1) {
    throw new Error(`PRINT_CSS 里没有选择器：${selector}`);
  }
  const open = flat.indexOf("{", start);
  return flat.slice(open, flat.indexOf("}", open));
};

describe("publication-grade rules", () => {
  it.each(RULE_CASES.map((item) => [item.name, item] as const))("%s", (_name, item) => {
    expect(flat).toContain(item.selector);
    const body = declarationsOf(item.selector);
    expect(item.body.filter((declaration) => !body.includes(declaration))).toEqual([]);
  });

  it("should keep heading font sizes strictly decreasing (h1 > h2 > h3 > h4)", () => {
    const sizeOf = (selector: string): number =>
      Number(/font-size: ([\d.]+)pt/u.exec(declarationsOf(selector))?.[1] ?? "0");
    const sizes = ["h1 {", "h2 {", "h3 {", "h4 {"].map(sizeOf);
    expect(sizes).toEqual([...sizes].sort((left, right) => right - left));
    expect(new Set(sizes).size).toBe(4);
  });

  it("should cover serif CJK and monospace Latin in the font stacks", () => {
    expect(flat).toContain('"Songti SC"');
    expect(flat).toContain('"Source Han Serif SC"');
    expect(flat).toContain("ui-monospace");
  });

  it("should indent TOC entries deeper per level and dot-lead the title lines", () => {
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

  it("should give tables solid borders and keep images from overflowing", () => {
    expect(declarationsOf("th, td {")).toContain("border: 0.5pt solid");
    expect(declarationsOf("img {")).toContain("max-width: 100%;");
  });
});

describe("skeleton size and self-containment", () => {
  it("should stay within 8 KiB", () => {
    expect(Buffer.byteLength(PRINT_CSS, "utf8")).toBeLessThanOrEqual(8192);
  });

  it("should have zero external references: no @import, no url()", () => {
    expect(PRINT_CSS).not.toContain("@import");
    expect(PRINT_CSS).not.toContain("url(");
  });

  it("should select only by class and tag, never hard-coding a document-specific id", () => {
    expect(PRINT_CSS).not.toContain("#hr-");
  });

  it("should keep both class-name families effective (product uses .cover/.toc, templates use .print-*)", () => {
    expect(has([".cover", ".print-cover"])).toBe(true);
    expect(has([".toc", ".print-toc"])).toBe(true);
  });
});

describe("printCssOf paper guard", () => {
  /** The type is already narrowed, so reproducing "the CLI passed an off-dictionary paper" requires bypassing it at runtime: `Reflect.apply`, not `as`. */
  const failureOf = (paper: string): unknown => {
    try {
      Reflect.apply(printCssOf, undefined, [paper]);
    } catch (error: unknown) {
      return error;
    }
    throw new Error(`预期抛出 HrError：${paper}`);
  };

  const codeOf = (error: unknown): string => (error instanceof HrError ? error.code : "非 HrError");

  it("should throw invalid_input for an off-dictionary paper and carry the original value in the message", () => {
    const error = failureOf("b5");
    expect(error).toBeInstanceOf(HrError);
    expect(codeOf(error)).toBe("invalid_input");
    expect(error instanceof HrError ? error.message : "").toContain("b5");
  });

  it("should stop silently emitting `size: ;` for an empty string", () => {
    expect(codeOf(failureOf(""))).toBe("invalid_input");
  });

  it("should still emit one keyword for each of the three valid papers", () => {
    const sizes = (["a4", "letter", "a5"] as const).map(
      (paper) => /size: ([^;]+);/u.exec(printCssOf(paper))?.[1],
    );
    expect(sizes).toEqual(["A4", "letter", "A5"]);
  });
});

describe("slidesPrintCssOf one-page-per-screen skeleton", () => {
  const css = slidesPrintCssOf();

  it("should hard-code the 16:9 page frame: the missing paper parameter is deliberate (slides rejects --page-size)", () => {
    expect(css).toContain("size: 13.333in 7.5in;");
    expect(css).not.toContain("@@paper@@");
  });

  it("should force a page break on every top-level slide element (the first h1 and each section)", () => {
    expect(css).toContain("article > h1");
    expect(css).toContain("article > section");
    expect(css).toContain("break-after: page;");
  });
});
