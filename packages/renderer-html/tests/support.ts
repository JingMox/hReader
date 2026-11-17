// 这层管：测试用的 fixture 读取、输入装配与"数节点"工具（AC-7 要求按解析后的树数，不 grep 字符串）；不承载断言。

import { readFileSync } from "node:fs";

import { buildOutline, injectNodeIds, parseHtml, serializeHtml } from "@hreader/core";
import type { HtmlElementNode, HtmlNode, OutlineNode } from "@hreader/core";

import type { PrintHtmlInput } from "../src/index";

const FIXTURE_DIR = new URL("./fixtures/", import.meta.url);

interface InputOverrides {
  readonly title?: string;
  readonly docId?: string;
  readonly visualId?: string;
  readonly bodyClass?: string;
  readonly themeCss?: string;
}

export const fixtureOf = (name: string): string => readFileSync(new URL(name, FIXTURE_DIR), "utf8");

/** 走真实链路：先注入 `data-hr-id`，再由同一份解析树建 outline——CLI 读到文档后正是这个形状。 */
export const inputOf = (documentHtml: string, overrides: InputOverrides = {}): PrintHtmlInput => {
  const parsed = injectNodeIds(parseHtml(documentHtml)).parsed;
  return {
    docId: overrides.docId ?? "sample-doc",
    visualId: overrides.visualId ?? "atelier-editorial",
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
      // 逆序压栈，弹出时才是文档顺序（前序 DFS）。
      stack.push(...[...current.children].reverse());
    }
  }
  return found;
};

export const elementsOfHtml = (html: string): readonly HtmlElementNode[] =>
  elementsOf(parseHtml(html).root);

/** 标签名比对不分大小写：parse5 在 SVG 语境产 `feImage`/`clipPath`，严格比对会让用例恒空（§13.7）。 */
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

/** 产物里所有 `id` 属性值（按文档序）；锚点唯一性/死链用例共用。 */
export const idsOfHtml = (html: string): readonly string[] =>
  elementsOfHtml(html).flatMap((element) => {
    const id = attrOf(element, "id");
    return id === undefined ? [] : [id];
  });

/** 产物里所有 `href="#…"` 指向的锚（去掉 `#`）。 */
export const anchorHrefsOfHtml = (html: string): readonly string[] =>
  tagsOf(parseHtml(html).root, "a")
    .map((link) => attrOf(link, "href") ?? "")
    .filter((href) => href.startsWith("#"))
    .map((href) => href.slice(1));
