// 这层管：属性读取与"块级元素"判定（与 html/inject.ts 同口径）；不做校验、不碰 IO。

import type { HtmlAttribute, HtmlElementNode } from "../../html/constants";
import { PATCHABLE_TAGS } from "../../html/constants";

export const attributeValue = (
  attrs: readonly HtmlAttribute[],
  name: string,
): string | undefined => {
  for (const [attributeName, value] of attrs) {
    if (attributeName === name) return value;
  }
  return undefined;
};

export const hasAttribute = (attrs: readonly HtmlAttribute[], name: string): boolean =>
  attrs.some(([attributeName]) => attributeName === name);

/** 解析器保留属性名源码大小写（SVG 的 `attributeName` 就是驼峰）：按名取值必须统一小写比较。 */
export const attributeValueLoose = (
  attrs: readonly HtmlAttribute[],
  name: string,
): string | undefined => {
  const needle = name.toLowerCase();
  for (const [attributeName, value] of attrs) {
    if (attributeName.toLowerCase() === needle) return value;
  }
  return undefined;
};

/** 同上，只判存在。 */
export const hasAttributeLoose = (attrs: readonly HtmlAttribute[], name: string): boolean =>
  attrs.some(([attributeName]) => attributeName.toLowerCase() === name.toLowerCase());

/**
 * 只有可作目标的元素能被 patch：patch 是按"块"做的最小改动单元，行内元素一旦被替换会拆散
 * 周围文本的排版假设。集合见 `PATCHABLE_TAGS`（默认等于可寻址集合：`div`/`tr`/`td` 这些不再是死区）。
 */
export const isBlockLevel = (node: HtmlElementNode): boolean => PATCHABLE_TAGS.has(node.tag);
