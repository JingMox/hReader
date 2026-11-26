// Test fixture loading, input assembly, and node-counting helpers (counted on the parsed tree, never by grepping strings); carries no assertions.

import { readFileSync } from "node:fs";

import { buildOutline, injectNodeIds, parseHtml, serializeHtml } from "@hreader/core";
import type { HtmlElementNode, HtmlNode, OutlineNode } from "@hreader/core";

import type { PaperSize, PrintHtmlInput } from "../src/index";

const FIXTURE_DIR = new URL("./fixtures/", import.meta.url);

interface InputOverrides {
  readonly paper?: PaperSize;
  readonly title?: string;
  readonly docId?: string;
  readonly visualId?: string;
  readonly bodyClass?: string;
  readonly themeCss?: string;
}

export const fixtureOf = (name: string): string => readFileSync(new URL(name, FIXTURE_DIR), "utf8");

/** Walks the real pipeline: inject `data-hr-id` first, then build the outline from the same parsed tree — exactly the shape the CLI sees after reading a document. */
export const inputOf = (documentHtml: string, overrides: InputOverrides = {}): PrintHtmlInput => {
  const parsed = injectNodeIds(parseHtml(documentHtml)).parsed;
  return {
    docId: overrides.docId ?? "sample-doc",
    visualId: overrides.visualId ?? "atelier-editorial",
    paper: overrides.paper ?? "a4",
    documentHtml: serializeHtml(parsed),
    themeCss: overrides.themeCss ?? "",
    outline: buildOutline(parsed).nodes,
    ...(overrides.title === undefined ? {} : { title: overrides.title }),
    ...(overrides.bodyClass === undefined ? {} : { bodyClass: overrides.bodyClass }),
  };
};

export const elementsOf = (node: HtmlNode): readonly HtmlElementNode[] => {
  const found: HtmlElementNode[] = [];
  const stack: HtmlNode[] = [node];
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    if (current.kind === "element") {
      found.push(current);
    }
    if (current.kind === "element" || current.kind === "document") {
      // Push in reverse so pops yield document order (pre-order DFS).
      stack.push(...[...current.children].reverse());
    }
  }
  return found;
};

export const elementsOfHtml = (html: string): readonly HtmlElementNode[] =>
  elementsOf(parseHtml(html).root);

/** Tag-name comparison is case-insensitive: parse5 emits `feImage`/`clipPath` in SVG context, and an exact match would leave cases permanently empty. */
export const tagsOf = (node: HtmlNode, tag: string): readonly HtmlElementNode[] =>
  elementsOf(node).filter((element) => element.tag.toLowerCase() === tag.toLowerCase());

export const firstTagOf = (node: HtmlNode, tag: string): HtmlElementNode => {
  const [first] = tagsOf(node, tag);
  if (first === undefined) {
    throw new Error(`产物里没有 <${tag}>`);
  }
  return first;
};

export const attrOf = (node: HtmlElementNode, name: string): string | undefined =>
  node.attrs.find(([key]) => key === name)?.[1];

export const classesOf = (node: HtmlElementNode): readonly string[] =>
  (attrOf(node, "class") ?? "").split(/\s+/u).filter((token) => token !== "");

export const textOf = (node: HtmlNode): string => {
  if (node.kind === "text") {
    return node.value;
  }
  if (node.kind === "element" || node.kind === "document") {
    return node.children.map((child) => textOf(child)).join("");
  }
  return "";
};

export const flattenOutline = (nodes: readonly OutlineNode[]): readonly OutlineNode[] =>
  nodes.flatMap((node) => [node, ...flattenOutline(node.children)]);

export const isHeading = (node: OutlineNode): boolean => /^h[1-6]$/u.test(node.tag);

/** All `id` attribute values in the product, in document order; shared by the anchor-uniqueness and dead-link cases. */
export const idsOfHtml = (html: string): readonly string[] =>
  elementsOfHtml(html).flatMap((element) => {
    const id = attrOf(element, "id");
    return id === undefined ? [] : [id];
  });

/** All anchors targeted by `href="#…"` in the product (with the `#` stripped). */
export const anchorHrefsOfHtml = (html: string): readonly string[] =>
  tagsOf(parseHtml(html).root, "a")
    .map((link) => attrOf(link, "href") ?? "")
    .filter((href) => href.startsWith("#"))
    .map((href) => href.slice(1));
