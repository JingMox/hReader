// 这层管：在 HTML 树里定位唯一的 `<article>`；不遍历子树内容、不改树。

import type { HtmlElementNode, HtmlNode } from "../../html/constants";
import { drainStack } from "../../html/stack";

export const firstArticleOf = (root: HtmlNode): HtmlElementNode | undefined => {
  const stack: HtmlNode[] = [root];
  for (const current of drainStack(stack)) {
    if (current.kind === "element" && current.tag === "article") {
      return current;
    }
    if (current.kind === "element" || current.kind === "document") {
      for (const child of current.children) {
        stack.push(child);
      }
      continue;
    }
  }
  return undefined;
};
