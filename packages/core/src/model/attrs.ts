// 这层管：模型对单个 HTML 元素的判定（属性取值、块级、合法 id、合法 component）；不做遍历。

import {
  BLOCK_TAGS,
  COMPONENT_ATTRIBUTE,
  COMPONENT_WHITELIST,
  HR_ID_ATTRIBUTE,
  HR_ID_PATTERN,
  type HtmlElementNode,
} from "../html/constants";

export const attributeOf = (node: HtmlElementNode, name: string): string | undefined => {
  for (const [attributeName, value] of node.attrs) {
    if (attributeName === name) {
      return value;
    }
  }
  return undefined;
};

/** 模型面是寻址面的子集：块级标签，或带 `data-hr-component` 的 `div`（比 `ADDRESSABLE_TAGS` 窄）。 */
export const isBlockElement = (node: HtmlElementNode): boolean =>
  BLOCK_TAGS.has(node.tag) ||
  (node.tag === "div" && attributeOf(node, COMPONENT_ATTRIBUTE) !== undefined);

/** 合法 id 才进模型；非法/缺失返回空串，由 `validateDocument` 出诊断。 */
export const validIdOf = (node: HtmlElementNode): string => {
  const id = attributeOf(node, HR_ID_ATTRIBUTE);
  return id !== undefined && HR_ID_PATTERN.test(id) ? id : "";
};

/** 白名单内的 component 才进模型；非法值留空（诊断由 M1.1 解析层发，不重复发）。 */
export const componentOf = (node: HtmlElementNode): string | undefined => {
  const value = attributeOf(node, COMPONENT_ATTRIBUTE);
  return value !== undefined && COMPONENT_WHITELIST.includes(value) ? value : undefined;
};
