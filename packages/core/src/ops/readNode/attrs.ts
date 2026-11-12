// 这层管：元素属性取值（只认 `data-hr-id`）；不判外壳、不遍历。

import type { HtmlElementNode } from "../../html/constants";

export const attributeOf = (node: HtmlElementNode, name: string): string | undefined => {
  for (const [attributeName, value] of node.attrs) {
    if (attributeName === name) {
      return value;
    }
  }
  return undefined;
};

/** 锚点只认 `data-hr-id`：作者页面的 `id` 不得成为锚点（会与 `hr-meta` 的 id 空间混淆）。 */
export const identifierOf = (node: HtmlElementNode): string | undefined =>
  attributeOf(node, "data-hr-id");
