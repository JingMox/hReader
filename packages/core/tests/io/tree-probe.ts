// 这层管：测试侧的只读树查询（按 ID 定位、父链、子元素序列、文本）；不改树、不序列化、不做断言。

import type { HtmlElementNode, HtmlNode } from "../../src/html/constants";
import { parseHtml } from "../../src/html/parse";
import { attributeValue } from "../../src/ops/patch-node/attrs";

export interface LocatedElement {
  readonly node: HtmlElementNode;
  /** 从最外层容器到父元素的元素链（不含自身）。 */
  readonly chain: readonly HtmlElementNode[];
}

const ID_ATTRIBUTE = "data-hr-id";

export const found = (located: LocatedElement | undefined, what: string): LocatedElement => {
  if (located === undefined) throw new Error(`测试装置：树里找不到 ${what}`);
  return located;
};

const childrenOf = (node: HtmlNode): readonly HtmlNode[] =>
  node.kind === "document" || node.kind === "element" ? node.children : [];

const search = (
  node: HtmlNode,
  matches: (node: HtmlElementNode) => boolean,
  chain: readonly HtmlElementNode[],
): LocatedElement | undefined => {
  if (node.kind === "element" && matches(node)) return { node, chain };
  const next = node.kind === "element" ? [...chain, node] : chain;
  for (const child of childrenOf(node)) {
    const hit = search(child, matches, next);
    if (hit !== undefined) return hit;
  }
  return undefined;
};

const elementsOf = (node: HtmlNode, visit: (node: HtmlElementNode) => void): void => {
  if (node.kind === "element") visit(node);
  for (const child of childrenOf(node)) elementsOf(child, visit);
};

const textOf = (node: HtmlNode, chunks: string[]): string[] => {
  if (node.kind === "text") chunks.push(node.value);
  for (const child of childrenOf(node)) textOf(child, chunks);
  return chunks;
};

export const elementById = (html: string, id: string): LocatedElement | undefined =>
  search(parseHtml(html).root, (node) => attributeValue(node.attrs, ID_ATTRIBUTE) === id, []);

export const countOf = (html: string, tag: string): number => {
  let count = 0;
  elementsOf(parseHtml(html).root, (node) => {
    if (node.tag === tag) count += 1;
  });
  return count;
};

export const childElementsOf = (html: string, parentId: string): readonly HtmlElementNode[] => {
  const parent = found(elementById(html, parentId), `#${parentId}`);
  return parent.node.children.filter((child): child is HtmlElementNode => child.kind === "element");
};

/** 子元素上的 `data-hr-id` 序列（缺失时写 `<no-id>`）：位置断言用。 */
export const childIds = (html: string, parentId: string): readonly string[] =>
  childElementsOf(html, parentId).map(
    (child) => attributeValue(child.attrs, ID_ATTRIBUTE) ?? "<no-id>",
  );

export const childTags = (html: string, parentId: string): readonly string[] =>
  childElementsOf(html, parentId).map((child) => child.tag);

export const textIn = (html: string, parentId: string): string => {
  const parent = found(elementById(html, parentId), `#${parentId}`);
  return textOf(parent.node, []).join("");
};

export const tagsInOrder = (html: string): readonly string[] => {
  const tags: string[] = [];
  elementsOf(parseHtml(html).root, (node) => tags.push(node.tag));
  return tags;
};

export const attrValues = (html: string, id: string): readonly (readonly [string, string])[] =>
  found(elementById(html, id), `#${id}`).node.attrs;
