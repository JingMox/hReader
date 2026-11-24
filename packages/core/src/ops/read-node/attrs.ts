// 这层管：元素属性取值（只认 `data-hr-id`）；不判外壳、不遍历。

import type { HtmlElementNode } from "../../html/constants";
import { attributeValue } from "../../html/hr-ids";

// 取值循环只有一份，住在 `html/hr-ids.ts`；`html/` 不依赖 `ops/`，委托方向只能是这样。
export const attributeOf = (node: HtmlElementNode, name: string): string | undefined =>
  attributeValue(node.attrs, name);

/** 锚点只认 `data-hr-id`：作者页面的 `id` 不得成为锚点（会与 `hr-meta` 的 id 空间混淆）。 */
export const identifierOf = (node: HtmlElementNode): string | undefined =>
  attributeOf(node, "data-hr-id");
