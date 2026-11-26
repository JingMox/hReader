import { parseHtml } from "@hreader/core";
import type { HtmlElementNode, HtmlNode } from "@hreader/core";
import { describe, expect, it } from "vitest";

import { printHtmlReportOf } from "../src/index";
import {
  attrOf,
  classesOf,
  elementsOf,
  fixtureOf,
  firstTagOf,
  inputOf,
  tagsOf,
  textOf,
} from "./support";

const report = printHtmlReportOf(inputOf(fixtureOf("article-noisy.html")));
const root = parseHtml(report.html).root;
const article = firstTagOf(root, "article");
const inside = elementsOf(article);

const RESOURCE_ATTRIBUTES = ["src", "srcset", "poster"] as const;

const valuesOf = (node: HtmlNode, name: string): readonly string[] =>
  elementsOf(node).flatMap((element) => {
    const value = attrOf(element, name);
    return value === undefined ? [] : [value];
  });

/** Returns the innermost matching element: in `<p><a>text</a></p>` the answer is `<a>`, not the outer `<p>`/`<article>`. */
const elementWithText = (node: HtmlNode, text: string): HtmlElementNode | undefined => {
  const matches = elementsOf(node).filter((element) => textOf(element).includes(text));
  return matches[matches.length - 1];
};

describe("interactive UI and external media: whole-node removal", () => {
  it.each([
    "script",
    "style",
    "link",
    "iframe",
    "object",
    "embed",
    "video",
    "audio",
    "form",
    "button",
    "input",
    "select",
    "textarea",
  ])("should leave no <%s> in the body", (tag) => {
    expect(tagsOf(article, tag)).toEqual([]);
  });

  it("should keep nodes with UI classes, data-hr-ui, or contenteditable out of the product", () => {
    expect(
      inside.filter((element) => classesOf(element).some((token) => token.startsWith("hr-"))),
    ).toEqual([]);
    expect(inside.filter((element) => attrOf(element, "data-hr-ui") !== undefined)).toEqual([]);
    expect(inside.filter((element) => attrOf(element, "contenteditable") !== undefined)).toEqual(
      [],
    );
  });

  it("should remove at tree level rather than hide via CSS (no script tag is findable in the HTML)", () => {
    expect(report.html).not.toContain("<script");
    expect(report.html).not.toContain("<iframe");
  });
});

describe("SVG resource elements and head style scoping", () => {
  it("should remove image/use/feImage wholesale (no href allowlist — even same-document #symbol goes)", () => {
    // First prove the check can "see": parse5 keeps camelCase in SVG context, so a strict helper comparison
    // would leave the 0-assertion below green forever. Once `<svg>` is removed wholesale there is no feImage
    // left to find, and a bare count-0 assertion would be blind either way.
    const source = firstTagOf(parseHtml(fixtureOf("article-noisy.html")).root, "article");
    expect(tagsOf(source, "feImage").length).toBe(1);
    expect(tagsOf(source, "feimage").length).toBe(1);
    expect(tagsOf(source, "FEIMAGE").length).toBe(1);
    expect(tagsOf(article, "feImage").length).toBe(0);
    for (const tag of ["image", "use", "feimage"]) {
      expect(tagsOf(article, tag)).toEqual([]);
      expect(tagsOf(article, tag.toUpperCase())).toEqual([]);
    }
  });

  it("should not flag our own two <style> tags in head (theme + print skeleton) since the sentinel only scans the body", () => {
    expect(tagsOf(root, "style").length).toBe(2);
    expect(tagsOf(article, "style").length).toBe(0);
  });
});

describe("XSS: event attributes and pseudo-protocols", () => {
  it("should strip every on* event attribute (including svg onload)", () => {
    const handlers = inside.flatMap((element) =>
      element.attrs.filter(([name]) => name.startsWith("on")),
    );
    expect(handlers).toEqual([]);
    expect(report.html).not.toContain("alert(1)");
  });

  it("should drop only the attribute on javascript:/vbscript:/data:text/html links while keeping the link text", () => {
    const dangerous = valuesOf(article, "href").concat(valuesOf(article, "xlink:href"));
    expect(
      dangerous.filter((value) => /^(?:javascript|vbscript|data:text\/html)/iu.test(value.trim())),
    ).toEqual([]);
    const bad = elementWithText(article, "坏链接");
    expect(bad?.tag).toBe("a");
    expect(attrOf(bad ?? firstTagOf(article, "p"), "href")).toBeUndefined();
    expect(elementWithText(article, "数据链接")?.tag).toBe("a");
  });

  it("should keep a normal https link verbatim", () => {
    const good = elementWithText(article, "好链接");
    expect(good?.tag).toBe("a");
    expect(attrOf(good ?? firstTagOf(article, "p"), "href")).toBe("https://example.com/x");
  });

  it("should drop external url() inside style along with the whole style attribute", () => {
    const styled = elementWithText(article, "带外链样式的段落");
    expect(styled?.tag).toBe("p");
    expect(attrOf(styled ?? firstTagOf(article, "p"), "style")).toBeUndefined();
  });
});

describe("external resources: only inline data:image is allowed", () => {
  it("should remove relative-path and http(s) images wholesale and report the count to the caller", () => {
    expect(tagsOf(article, "img").length).toBe(1);
    // The count covers images only: one `<img src="x.png">` plus one SVG `<image>`; `<svg>`/`<use>`/`<feImage>` do not count.
    expect(report.droppedImages).toBe(2);
    expect(elementWithText(article, "相对路径图")).toBeUndefined();
  });

  it("should keep src on a data:image picture", () => {
    const inline = firstTagOf(article, "img");
    expect(attrOf(inline, "src")).toMatch(/^data:image\//u);
    expect(attrOf(inline, "alt")).toBe("内联图");
  });

  it("should leave only inline data:image in src/srcset/poster with no http(s) resource", () => {
    const resources = RESOURCE_ATTRIBUTES.flatMap((name) => valuesOf(article, name));
    expect(resources.filter((value) => value.trim().startsWith("http"))).toEqual([]);
    expect(resources.filter((value) => !value.trim().startsWith("data:image/"))).toEqual([]);
    expect(resources).toEqual(["data:image/png;base64,iVBORw0KGgo="]);
  });

  it("should keep the SVG itself while removing event attributes under the on* rule", () => {
    expect(tagsOf(article, "svg").length).toBe(1);
  });
});

describe("srcset multi-candidate", () => {
  const srcsetReport = printHtmlReportOf(inputOf(fixtureOf("article-srcset.html")));
  const srcsetArticle = firstTagOf(parseHtml(srcsetReport.html).root, "article");
  const alts = tagsOf(srcsetArticle, "img").map((image) => attrOf(image, "alt"));

  it("should keep the whole picture when every candidate is an inline data:image", () => {
    expect(alts).toContain("全内联候选");
  });

  it("should remove and count the whole picture when any candidate is external", () => {
    expect(alts).not.toContain("混外链候选");
    expect(srcsetReport.droppedImages).toBe(1);
    expect(srcsetArticle).not.toContain("cdn.example");
  });
});

describe("clean documents are not over-removed", () => {
  const clean = printHtmlReportOf(inputOf(fixtureOf("article.html")));

  it("should report no removals when the document has no external resources", () => {
    expect(clean.droppedImages).toBe(0);
  });

  it("should keep body paragraphs and container structure intact", () => {
    const cleanRoot = parseHtml(clean.html).root;
    expect(tagsOf(cleanRoot, "p").length).toBeGreaterThan(4);
    expect(tagsOf(cleanRoot, "section").length).toBe(4);
  });
});
