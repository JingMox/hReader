// 这层管：定位/诊断 path 的唯一拼装口径（父 `children` 里的原始下标）；不做匹配、不判错。

/** 段 = `标签[原始下标]`：下标与解析器的 `childNodes` 对齐（文本、注释、doctype 也占位）。 */
export const pathSegment = (tag: string, index: number): string => `${tag}[${String(index)}]`;

export const joinPath = (parentPath: string, segment: string): string =>
  parentPath === "" ? segment : `${parentPath}>${segment}`;
