// 这层管：`data-hr-id` 的读写与去重（取值、计数、生成不冲突的 id）；不懂节点语义、不扣 id 规则。

import { HR_ID_ATTRIBUTE, HR_ID_PATTERN, type HtmlAttribute, type HtmlNode } from "./constants";
import { drainStack } from "./stack";

export const attributeValue = (
  attrs: readonly HtmlAttribute[],
  name: string,
): string | undefined => {
  for (const [attributeName, value] of attrs) {
    if (attributeName === name) {
      return value;
    }
  }
  return undefined;
};

/**
 * 全文合法 id 的出现次数：只回答"这个 id 合法且出现过几次"，而"能不能原样留下"
 * 取决于它是否**只出现一次**（重复 id 里第一个保留、其余重分配）。
 */
export const collectValidIdCounts = (root: HtmlNode): Map<string, number> => {
  const counts = new Map<string, number>();
  const stack: HtmlNode[] = [root];
  for (const current of drainStack(stack)) {
    if (current.kind === "element") {
      const id = attributeValue(current.attrs, HR_ID_ATTRIBUTE);
      if (id !== undefined && HR_ID_PATTERN.test(id)) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    if (current.kind === "element" || current.kind === "document") {
      for (const child of current.children) {
        stack.push(child);
      }
    }
  }
  return counts;
};

/** 后缀按文档顺序递增：同一文档两次调用逐字节一致，且与遍历起点无关。 */
export const uniqueId = (base: string, used: Set<string>): string => {
  if (!used.has(base)) {
    return base;
  }
  let suffix = 2;
  while (used.has(`${base}-${String(suffix)}`)) {
    suffix += 1;
  }
  return `${base}-${String(suffix)}`;
};

export const withHrId = (
  attrs: readonly HtmlAttribute[],
  id: string | undefined,
): readonly HtmlAttribute[] => {
  if (id === undefined) {
    return attrs;
  }
  return attrs.some(([name]) => name === HR_ID_ATTRIBUTE)
    ? attrs.map(([name, value]) =>
        name === HR_ID_ATTRIBUTE ? ([name, id] as const) : ([name, value] as const),
      )
    : [...attrs, [HR_ID_ATTRIBUTE, id] as const];
};
