// 这层管：在树里找第一个命中元素（文档序）；不改树、不校验、不碰 IO。

import type { HtmlElementNode, HtmlNode } from "../../html/constants";
import { drainStack } from "../../html/stack";

const pushChildrenReversed = (
  node: Extract<HtmlNode, { kind: "document" | "element" }>,
  stack: HtmlNode[],
): void => {
  for (let index = node.children.length - 1; index >= 0; index -= 1) {
    const child = node.children[index];
    if (child !== undefined) stack.push(child);
  }
};

/** 子节点倒序压栈，`drainStack` 弹出即文档序（pre-order）；命中第一个就返回。 */
export const findElement = (
  root: HtmlNode,
  matches: (node: HtmlElementNode) => boolean,
): HtmlElementNode | undefined => {
  const stack: HtmlNode[] = [root];
  for (const node of drainStack(stack)) {
    if (node.kind === "element" && matches(node)) return node;
    if (node.kind === "element" || node.kind === "document") pushChildrenReversed(node, stack);
  }
  return undefined;
};
