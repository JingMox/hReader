// 这层管：元素源码区间的**单一存在性判据**——只回答"元素在不在"，不替调用点决定"区间能不能用"。
// 元素在就至少给 `ZERO_SPAN`（parse5 给合成节点 `html/head/body` 就是这种情况），调用点必须自己判
// `span.end <= span.start`；这与 `style/apply.ts`、`ops/patchNode/apply.ts` 里两个局部 `spanOrZero`
// 不同：那两个是"缺失就补零宽"的取值工具，这里返回 `null` 只表示**元素不存在**（M2.3 P1-7/P2-2）。
//
// `ZERO_SPAN` 是零宽区间的**唯一真值源**：`html/parse.ts`、`style/apply.ts`、`ops/patchNode/apply.ts`
// 都从这里引用，不各自抄一份字面量。

import type { HtmlElementNode, SourceSpan } from "./constants";

export const ZERO_SPAN: SourceSpan = { start: 0, end: 0, innerStart: 0, innerEnd: 0 };

/** 元素在（包括解析器合成的节点）→ 区间，没有位置信息时是零宽；元素不存在 → `null`。 */
export function spanOf(node: HtmlElementNode): SourceSpan;
export function spanOf(node: HtmlElementNode | undefined): SourceSpan | null;
export function spanOf(node: HtmlElementNode | undefined): SourceSpan | null {
  if (node === undefined) return null;
  return node.span ?? ZERO_SPAN;
}
