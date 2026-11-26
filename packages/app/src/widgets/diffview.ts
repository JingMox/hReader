// 这层管：Visual Diff 的右栏渲染；只产出 NodeSpec，**不碰正文 DOM**。
// `ins`/`del` 用真实元素表达语义；Accept 只关视图、Revert 走 undo 请求（与正文无关）。

import type { DiffChunk, DiffKind, NodeSpec } from "../dom.ts";

export interface DiffView {
  readonly nodeId: string;
  readonly chunks: readonly DiffChunk[];
  readonly degraded: boolean;
  readonly reason?: string;
}

const kindTag: Readonly<Record<DiffKind, string>> = {
  same: "span",
  ins: "ins",
  del: "del",
};

/** 空 chunk 已在 `diffText` 丢弃；这里再做一次防御——右栏不该出现零宽元素。 */
export const diffSpecsOf = (view: DiffView): readonly NodeSpec[] =>
  view.chunks
    .filter((chunk) => chunk.text !== "")
    .map((chunk) => ({
      tag: kindTag[chunk.kind],
      // `data-hr-node` 让面板能标出"这是哪一块"的 diff（服务端按块算）。
      attrs: { "data-hr-diff": chunk.kind, "data-hr-node": view.nodeId },
      text: chunk.text,
    }));

export const diffStatusOf = (view: DiffView): string => {
  if (!view.degraded) return "字符级对比";
  return view.reason ?? "内容较长：已退化为按段落对比";
};
