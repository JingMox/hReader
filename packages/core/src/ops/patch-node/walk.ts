// 这层管：patch 侧的整树元素遍历（文档序 pre-order）；只遍历，不改树、不做判定。

import type { HtmlElementNode, HtmlNode } from "../../html/constants";
import { drainStack } from "../../html/stack";

/**
 * `document` 也要下钻：只写 `if (node.kind !== "element") continue` 会让遍历停在根上，
 * 整棵树一个元素都访问不到（测试必须有一条"根在 document 下"的用例）。
 */
export const walkElements = (root: HtmlNode, visit: (node: HtmlElementNode) => void): void => {
  const stack: HtmlNode[] = [root];
  for (const node of drainStack(stack)) {
    if (node.kind === "element") visit(node);
    if (node.kind !== "element" && node.kind !== "document") continue;
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) stack.push(child);
    }
  }
};
