import { parseHtml } from "@hreader/core";
import type { HtmlElementNode, HtmlNode } from "@hreader/core";
import { describe, expect, it } from "vitest";

import { printHtmlOf } from "../src/index";
import {
  attrOf,
  classesOf,
  elementsOf,
  fixtureOf,
  firstTagOf,
  flattenOutline,
  inputOf,
  isHeading,
  tagsOf,
  textOf,
} from "./support";

const input = inputOf(fixtureOf("article.html"));
const product = printHtmlOf(input);
const root = parseHtml(product).root;
const article = firstTagOf(root, "article");
const outlineNodes = flattenOutline(input.outline);
const outlineHeadings = outlineNodes.filter((node) => isHeading(node));
const headingTags = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

const headingsOf = (node: HtmlNode): readonly HtmlElementNode[] =>
  elementsOf(node).filter((element) => headingTags.some((tag) => tag === element.tag));

const secnumsOf = (node: HtmlNode): readonly string[] =>
  tagsOf(node, "span")
    .filter((span) => classesOf(span).includes("secnum"))
    .map((span) => textOf(span).trim());

const tocItemsOf = (node: HtmlNode): readonly HtmlElementNode[] =>
  tagsOf(node, "li").filter((item) => classesOf(item).includes("toc__item"));

const elementsByIdOf = (node: HtmlNode): ReadonlyMap<string, HtmlElementNode> =>
  new Map(
    elementsOf(node).flatMap((element) => {
      const id = attrOf(element, "id");
      return id === undefined ? [] : [[id, element] as const];
    }),
  );

const byId = elementsByIdOf(article);
const headings = headingsOf(article);
const tocItems = tocItemsOf(root);
const tocHrefs = tocItems.map((item) => attrOf(firstTagOf(item, "a"), "href") ?? "");
const headingHrefs = elementsOf(article).flatMap((element) => {
  const id = attrOf(element, "id") ?? "";
  return id.startsWith("sec-") ? [`#${id}`] : [];
});

describe("three-part structure", () => {
  it("should assemble cover, TOC, then body in that order", () => {
    const coverAt = product.indexOf('<header class="cover">');
    const tocAt = product.indexOf('<nav class="toc"');
    const articleAt = product.indexOf("\n<article");
    expect(coverAt).toBeGreaterThan(-1);
    expect(tocAt).toBeGreaterThan(coverAt);
    expect(articleAt).toBeGreaterThan(tocAt);
  });

  it("should emit a complete document shell with two meta tags", () => {
    expect(product.startsWith('<!DOCTYPE html>\n<html lang="zh-CN">')).toBe(true);
    const metas = tagsOf(root, "meta").map((meta) => [
      attrOf(meta, "name"),
      attrOf(meta, "content"),
    ]);
    expect(metas).toContainEqual(["hr-doc-id", "sample-doc"]);
    expect(metas).toContainEqual(["hr-visual", "atelier-editorial"]);
  });

  it("should emit <body> without a class when bodyClass is omitted and verbatim when supplied", () => {
    expect(product).toContain("\n<body>\n");
    const withClass = printHtmlOf({ ...input, bodyClass: "visual-atelier-editorial" });
    expect(withClass).toContain('<body class="visual-atelier-editorial">');
  });

  it("should mark every non-heading container with the chapter class, matching the outline container count", () => {
    const containers = outlineNodes.filter((node) => !isHeading(node));
    const chapters = elementsOf(article).filter((element) =>
      classesOf(element).includes("chapter"),
    );
    expect(containers.length).toBe(4);
    expect(chapters.length).toBe(containers.length);
    expect(chapters.every((element) => element.tag === "section")).toBe(true);
  });
});

describe("container class names", () => {
  it("should keep a source container class alongside chapter instead of swallowing it", () => {
    const html = printHtmlOf(
      inputOf('<article><section class="part"><h2>小节</h2></section></article>'),
    );
    const classes = elementsOf(parseHtml(html).root)
      .filter((element) => element.tag === "section")
      .map((element) => classesOf(element).join(" "));
    expect(classes).toEqual(["part chapter"]);
  });
});

describe("numbering", () => {
  it("should number incrementally by outline level, excluding container nodes", () => {
    expect(secnumsOf(article)).toEqual(["1", "1.1", "1.2", "1.2.1", "1.3", "1.3.1", "1.4"]);
  });

  it("should emit exactly as many headings as the outline has heading nodes", () => {
    expect(outlineHeadings.length).toBe(7);
    expect(headings.length).toBe(outlineHeadings.length);
  });

  it("should keep the outline text readable inside each heading (the number is an extra inserted span)", () => {
    const rendered = headings.map((heading) => textOf(heading).trim());
    outlineHeadings.forEach((node, index) => {
      expect(rendered[index] ?? "").toContain(node.text);
    });
  });
});

describe("table of contents", () => {
  it("should list only headings, not container nodes", () => {
    expect(tocItems.length).toBe(outlineHeadings.length);
    expect(tocItems.map((item) => attrOf(item, "data-toc-id"))).toEqual(
      outlineHeadings.map((node) => node.id),
    );
  });

  it("should distinguish same-named headings by number and data-toc-id", () => {
    const duplicate = tocItems.filter((item) => textOf(item).includes("方法"));
    expect(duplicate.length).toBe(2);
    expect(new Set(duplicate.map((item) => textOf(item))).size).toBe(2);
    expect(new Set(duplicate.map((item) => attrOf(item, "data-toc-id"))).size).toBe(2);
  });

  it("should derive the level class from the emitted heading tag", () => {
    for (const item of tocItems) {
      const target = byId.get((attrOf(firstTagOf(item, "a"), "href") ?? "").slice(1));
      expect(target === undefined ? "" : target.tag).toMatch(/^h[1-4]$/u);
      expect(classesOf(item)).toContain(`toc__item--h${(target?.tag ?? "").slice(1)}`);
    }
  });

  it("should be reachable to and from the body with no duplicate entries for one heading", () => {
    expect(new Set(tocHrefs).size).toBe(tocHrefs.length);
    expect([...tocHrefs].sort()).toEqual([...headingHrefs].sort());
  });
});

describe("nested article", () => {
  const noisyRoot = parseHtml(printHtmlOf(inputOf(fixtureOf("article-noisy.html")))).root;
  const noisyArticle = firstTagOf(noisyRoot, "article");

  it("should demote an inner <article> to div while preserving its attributes", () => {
    expect(tagsOf(noisyRoot, "article").length).toBe(1);
    const inner = elementsOf(noisyArticle).filter((element) =>
      classesOf(element).includes("inner"),
    );
    expect(inner.length).toBe(1);
    expect(inner[0]?.tag).toBe("div");
    expect(attrOf(firstTagOf(noisyArticle, "div"), "data-hr-id")).toBe("inner-article");
  });

  it("should still number inner sections and list them in the TOC", () => {
    expect(tocItemsOf(noisyRoot).some((item) => textOf(item).includes("内层小节"))).toBe(true);
  });
});
