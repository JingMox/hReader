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

describe("三段结构", () => {
  it("按封面 → 目录 → 正文的顺序拼接", () => {
    const coverAt = product.indexOf('<header class="cover">');
    const tocAt = product.indexOf('<nav class="toc"');
    const articleAt = product.indexOf("\n<article");
    expect(coverAt).toBeGreaterThan(-1);
    expect(tocAt).toBeGreaterThan(coverAt);
    expect(articleAt).toBeGreaterThan(tocAt);
  });

  it("输出完整文档外壳与两份 meta", () => {
    expect(product.startsWith('<!DOCTYPE html>\n<html lang="zh-CN">')).toBe(true);
    const metas = tagsOf(root, "meta").map((meta) => [
      attrOf(meta, "name"),
      attrOf(meta, "content"),
    ]);
    expect(metas).toContainEqual(["hr-doc-id", "sample-doc"]);
    expect(metas).toContainEqual(["hr-visual", "atelier-editorial"]);
  });

  it("不传 bodyClass 时 <body> 不带 class，传了则原样输出", () => {
    expect(product).toContain("\n<body>\n");
    const withClass = printHtmlOf({ ...input, bodyClass: "visual-atelier-editorial" });
    expect(withClass).toContain('<body class="visual-atelier-editorial">');
  });

  it("非标题容器都带 chapter 类，数量等于 outline 容器数", () => {
    const containers = outlineNodes.filter((node) => !isHeading(node));
    const chapters = elementsOf(article).filter((element) =>
      classesOf(element).includes("chapter"),
    );
    expect(containers.length).toBe(4);
    expect(chapters.length).toBe(containers.length);
    expect(chapters.every((element) => element.tag === "section")).toBe(true);
  });
});

describe("容器类名", () => {
  it("源容器自带 class 时与 chapter 并存，源 class 不被吞掉", () => {
    const html = printHtmlOf(
      inputOf('<article><section class="part"><h2>小节</h2></section></article>'),
    );
    const classes = elementsOf(parseHtml(html).root)
      .filter((element) => element.tag === "section")
      .map((element) => classesOf(element).join(" "));
    expect(classes).toEqual(["part chapter"]);
  });
});

describe("编号", () => {
  it("按 outline 的 level 自增编号，容器节点不参与", () => {
    expect(secnumsOf(article)).toEqual(["1", "1.1", "1.2", "1.2.1", "1.3", "1.3.1", "1.4"]);
  });

  it("标题总数与 outline 的标题节点数相等", () => {
    expect(outlineHeadings.length).toBe(7);
    expect(headings.length).toBe(outlineHeadings.length);
  });

  it("每个标题的文本里仍能读到 outline 文本（编号是额外插进去的 span）", () => {
    const rendered = headings.map((heading) => textOf(heading).trim());
    outlineHeadings.forEach((node, index) => {
      expect(rendered[index] ?? "").toContain(node.text);
    });
  });
});

describe("目录", () => {
  it("只收标题，不收容器节点", () => {
    expect(tocItems.length).toBe(outlineHeadings.length);
    expect(tocItems.map((item) => attrOf(item, "data-toc-id"))).toEqual(
      outlineHeadings.map((node) => node.id),
    );
  });

  it("同名标题靠编号与 data-toc-id 区分", () => {
    const duplicate = tocItems.filter((item) => textOf(item).includes("方法"));
    expect(duplicate.length).toBe(2);
    expect(new Set(duplicate.map((item) => textOf(item))).size).toBe(2);
    expect(new Set(duplicate.map((item) => attrOf(item, "data-toc-id"))).size).toBe(2);
  });

  it("层级类名来自落地标题的 tag（D6 契约）", () => {
    for (const item of tocItems) {
      const target = byId.get((attrOf(firstTagOf(item, "a"), "href") ?? "").slice(1));
      expect(target === undefined ? "" : target.tag).toMatch(/^h[1-4]$/u);
      expect(classesOf(item)).toContain(`toc__item--h${(target?.tag ?? "").slice(1)}`);
    }
  });

  it("与正文双向可达，且没有指向同一标题的重复项", () => {
    expect(new Set(tocHrefs).size).toBe(tocHrefs.length);
    expect([...tocHrefs].sort()).toEqual([...headingHrefs].sort());
  });
});

describe("嵌套 article", () => {
  const noisyRoot = parseHtml(printHtmlOf(inputOf(fixtureOf("article-noisy.html")))).root;
  const noisyArticle = firstTagOf(noisyRoot, "article");

  it("内层 <article> 降级为 div 并保留原属性", () => {
    expect(tagsOf(noisyRoot, "article").length).toBe(1);
    const inner = elementsOf(noisyArticle).filter((element) =>
      classesOf(element).includes("inner"),
    );
    expect(inner.length).toBe(1);
    expect(inner[0]?.tag).toBe("div");
    expect(attrOf(firstTagOf(noisyArticle, "div"), "data-hr-id")).toBe("inner-article");
  });

  it("内层小节照样进编号与目录", () => {
    expect(tocItemsOf(noisyRoot).some((item) => textOf(item).includes("内层小节"))).toBe(true);
  });
});
