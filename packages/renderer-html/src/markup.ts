// 这层管：HTML 文本/属性值的转义与属性串拼装；不做树遍历、不认识节点语义。

/** 文本节点的三种字符必须转义，否则 `<` 会把正文重新变成标签（XSS 的第一扇门）。 */
export const escapeText = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** 属性值多转义一个双引号：所有属性都用双引号包，`"` 提前闭合会逃出属性上下文。 */
export const escapeAttribute = (value: string): string =>
  escapeText(value).replaceAll('"', "&quot;");

/** 属性串（含每个属性前的空格）；空属性表返回空串，调用方不必判空。 */
export const utf8LengthOf = (text: string): number => new TextEncoder().encode(text).length;

export const attributeStringOf = (attrs: readonly (readonly [string, string])[]): string =>
  attrs.map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join("");
