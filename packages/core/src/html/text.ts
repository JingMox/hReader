// 这层管：把一棵子树的文本按文档序收集到上限为止（meta 校验要全文，ID 种子只要前缀）。

import { drainStack } from "./stack";
import type { HtmlNode } from "./constants";

const childNodesOf = (node: HtmlNode): readonly HtmlNode[] => {
  if (node.kind === "element" || node.kind === "document") {
    return node.children;
  }
  return [];
};

/**
 * 收集文本前缀：累计长度到 `limit` 立即停——大文档的 ID 种子只需要前几十字符，
 * 先拼全文再 slice 会让注入退化成 O(n·size)。`limit` 传 `Infinity` 即全文。
 */
export const textSampleOf = (node: HtmlNode, limit: number): string => {
  const chunks: string[] = [];
  let total = 0;
  const stack: HtmlNode[] = [node];
  for (const current of drainStack(stack)) {
    if (current.kind === "text") {
      chunks.push(current.value);
      total += current.value.length;
      if (total >= limit) {
        break;
      }
      continue;
    }
    const children = childNodesOf(current);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) {
        stack.push(child);
      }
    }
  }
  return chunks.join("").slice(0, limit);
};

export const textContentOf = (node: HtmlNode): string =>
  textSampleOf(node, Number.POSITIVE_INFINITY);
