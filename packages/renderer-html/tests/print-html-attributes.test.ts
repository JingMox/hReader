import { injectNodeIds, parseHtml } from "@hreader/core";
import type { OutlineNode } from "@hreader/core";
import { describe, expect, it } from "vitest";

import { printHtmlOf, printHtmlReportOf } from "../src/index";
import type { PrintHtmlInput } from "../src/index";
import {
  anchorHrefsOfHtml,
  attrOf,
  classesOf,
  elementsOfHtml,
  fixtureOf,
  firstTagOf,
  idsOfHtml,
  inputOf,
  tagsOf,
} from "./support";

const source = fixtureOf("article-hr-id.html");
const input = inputOf(source);
const product = printHtmlOf(input);
const root = parseHtml(product).root;
const article = firstTagOf(root, "article");
const idsOf = elementsOfHtml(product).map((element) => attrOf(element, "data-hr-id"));

describe("data-hr-id idempotence", () => {
  it("should preserve a valid source-document id verbatim", () => {
    for (const id of ["chapter-7", "doc-head", "legal-id", "sec-legal"]) {
      expect(idsOf).toContain(id);
    }
  });

  it("should have core rewrite an illegal id with an invalid_hr_id diagnostic, leaving the original out of the product", () => {
    const diagnostics = injectNodeIds(parseHtml(source)).parsed.diagnostics;
    expect(diagnostics.map((item) => item.code)).toContain("invalid_hr_id");
    const heading = tagsOf(article, "h2")[0];
    expect(attrOf(heading ?? article, "data-hr-id")).toMatch(/^hr-[0-9a-f]{8}$/u);
    expect(product).not.toContain("bad id!");
  });

  it("should attach numbering to the heading via core's rewritten id without breaking the link", () => {
    const heading = tagsOf(article, "h2")[0];
    expect(attrOf(heading ?? article, "id")).toMatch(/^sec-\d+(?:\.\d+)*$/u);
    expect(
      tagsOf(root, "li").filter((item) => attrOf(item, "data-toc-id") !== undefined).length,
    ).toBe(2);
  });
});

describe("chapter comes only from section", () => {
  it("should mark a section with the chapter class", () => {
    const section = tagsOf(article, "section")[0];
    expect(classesOf(section ?? article)).toContain("chapter");
  });

  it("should not mark a header container with the chapter class", () => {
    const header = tagsOf(article, "header")[0];
    expect(classesOf(header ?? article)).not.toContain("chapter");
  });
});

describe("generated anchors never collide with existing ids", () => {
  it("should yield a generated anchor to sec-1-2 when the source document owns sec-1", () => {
    const html = printHtmlOf(
      inputOf('<article><h2>甲</h2><div id="sec-1">x</div><h2>乙</h2></article>'),
    );
    const ids = idsOfHtml(html);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("sec-1");
    expect(ids).toContain("sec-1-2");
  });

  it("should also move the TOC container id aside when the source document owns hr-toc", () => {
    const html = printHtmlOf(inputOf('<article><p id="hr-toc">正文</p></article>'));
    expect(html).not.toContain('<nav class="toc" id="hr-toc">');
  });

  // Deliberate known behavior: rewriting a user id would break `<a href="#x">` internal links,
  // and a duplicate id is already invalid HTML — the source document is what needs fixing, not the render layer. The contract is still "no collision with existing ids".
  it("should preserve duplicate ids shipped by the source document", () => {
    const html = printHtmlOf(
      inputOf('<article><h2>甲</h2><div id="dup">x</div><div id="dup">y</div></article>'),
    );
    const ids = idsOfHtml(html);
    expect(ids.filter((id) => id === "dup")).toHaveLength(2);
    // Generated anchors still yield: no collision with dup is enough; tree-wide uniqueness is not required.
    expect(ids).toContain("sec-1");
  });

  it("should point every TOC link at an anchor that exists (no dead links after yielding)", () => {
    const html = printHtmlOf(
      inputOf('<article><div id="sec-1">x</div><h2>甲</h2><h2>乙</h2></article>'),
    );
    const ids = new Set(idsOfHtml(html));
    const hrefs = anchorHrefsOfHtml(html);
    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs.filter((href) => !ids.has(href))).toEqual([]);
  });
});

/** Assembles input directly: bypassing `inputOf`'s `injectNodeIds` is what produces a tree "without `data-hr-id`". */
const unnormalizedInputOf = (
  documentHtml: string,
  outline: readonly OutlineNode[],
): PrintHtmlInput => ({
  docId: "sample-doc",
  visualId: "atelier-editorial",
  paper: "a4",
  documentHtml,
  themeCss: "",
  outline,
});

// Outline entry ids use `x` so the fallback `""` stays distinguishable from every other literal — change it to
// `?? "x"` and a heading with `data-hr-id="x"` would disable the `""` branch, so no reservation would ever happen.
const headingOutline: readonly OutlineNode[] = [
  { id: "x", tag: "h1", level: 1, text: "标题甲", wordCount: 3, children: [] },
];

describe("un-normalized trees: existing ids without data-hr-id reserve first", () => {
  // An undefined `sectionId` is real input: an element with `id` but no `data-hr-id`. Its `id` must reserve first,
  // or a later generated `sec-…` would collide with it.
  it('should honor a reservation from id="sec-1" without data-hr-id and yield the generated anchor to sec-1-2', () => {
    const html = printHtmlOf(
      unnormalizedInputOf(
        '<article><p id="sec-1">占位</p><h1 data-hr-id="x">标题甲</h1></article>',
        headingOutline,
      ),
    );
    // The section heading receives the yielded sec-1-2, not the sec-1 already owned by <p>.
    expect(attrOf(firstTagOf(parseHtml(html).root, "h1"), "id")).toBe("sec-1-2");
    expect(anchorHrefsOfHtml(html)).toEqual(["sec-1-2"]);
    // The reserving element keeps its id verbatim, and the tree holds exactly one sec-1.
    expect(idsOfHtml(html).filter((id) => id === "sec-1")).toHaveLength(1);
  });

  it("should skip reservation when the same element gains a numbered data-hr-id, letting the generated anchor use sec-1", () => {
    const html = printHtmlOf(
      unnormalizedInputOf(
        '<article><p id="sec-1" data-hr-id="x">占位</p><h1>标题甲</h1></article>',
        headingOutline,
      ),
    );
    const ids = idsOfHtml(html);
    expect(ids.filter((id) => id === "sec-1-2")).toHaveLength(0);
    expect(anchorHrefsOfHtml(html)).toEqual(["sec-1"]);
    expect(ids).toContain("sec-1");
    // Same tree with only the `data-hr-id` moved: reserving or not must produce different output.
    expect(html).not.toBe(
      printHtmlOf(
        unnormalizedInputOf(
          '<article><p id="sec-1">占位</p><h1 data-hr-id="x">标题甲</h1></article>',
          headingOutline,
        ),
      ),
    );
  });
});

describe("byte count", () => {
  it("should report bytes equal to the product UTF-8 byte count (callers apply the limit check)", () => {
    const report = printHtmlReportOf(input);
    expect(report.bytes).toBe(Buffer.byteLength(report.html, "utf8"));
    expect(report.bytes).toBeGreaterThan(report.html.length);
  });
});

describe("re-exporting a print sheet (numbers do not stack)", () => {
  it("should replace a leading secnum instead of wrapping another layer around it", () => {
    // A user feeding an exported print sheet back into `hr export` must not produce a doubled number prefix.
    const twice = printHtmlOf(inputOf(product));
    const countOf = (html: string): number => (html.match(/class="secnum"/gu) ?? []).length;

    // The sheet must really carry a number, or the "no stacking" assertion below is trivially true.
    expect(countOf(product)).toBeGreaterThan(0);
    expect(countOf(twice)).toBe(countOf(product));
    expect(twice).not.toMatch(/class="secnum">[^<]*<\/span><span class="secnum"/u);
  });

  it("should not crash on an empty heading (no children)", () => {
    const html = printHtmlOf(inputOf("<article><h1></h1><p>正文</p></article>"));

    expect(html).toContain("正文");
    expect(html).toContain('class="secnum"');
  });
});
