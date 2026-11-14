// 这层管：划词 → 选区描述 → Intent（AC5.1/§2-4）；**不写文件、不碰 DOM 事件**。
// 跨块选区只取起点块并给出提示——跨块锚定是下一版的事（§2-4）。

import type { AnchorSpec } from "../dom.ts";

export interface RawSelection {
  /** 起点所在的 `data-hr-id`；选区跨块时也只有这一个。 */
  readonly nodeId: string;
  /** 起点块内的纯文本（不是整篇）。 */
  readonly blockText: string;
  readonly start: number;
  readonly end: number;
  /** 选区是否跨了多个块（由事件层比对起止块得出）。 */
  readonly crossBlock: boolean;
}

export type SelectionIntent =
  | { readonly kind: "annotate"; readonly nodeId: string; readonly anchor: AnchorSpec }
  | { readonly kind: "crossBlock" }
  | { readonly kind: "empty" };

/** 前缀/后缀各取 32 字符就够消歧；再长只会把 meta 撑大（AC1.1 的上限 64 也够）。 */
const CONTEXT_CHARS = 32;

const clamped = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), Math.max(min, max));

export const selectionIntentOf = (selection: RawSelection): SelectionIntent => {
  if (selection.crossBlock) return { kind: "crossBlock" };
  const start = clamped(selection.start, 0, selection.blockText.length);
  const end = clamped(selection.end, start, selection.blockText.length);
  const exact = selection.blockText.slice(start, end);
  if (exact.trim() === "") return { kind: "empty" };
  return {
    kind: "annotate",
    nodeId: selection.nodeId,
    anchor: {
      exact,
      prefix: selection.blockText.slice(Math.max(0, start - CONTEXT_CHARS), start),
      suffix: selection.blockText.slice(end, end + CONTEXT_CHARS),
      start,
    },
  };
};

/** 只带 `closest` + 文本读取的元素（`Element`/`HTMLElement` 的子集，便于纯测）。 */
export interface BlockElementLike {
  readonly getAttribute: (name: string) => string | null;
  readonly textContent: string | null;
  readonly closest: (selector: string) => {
    readonly textContent: string | null;
    readonly getAttribute: (name: string) => string | null;
  } | null;
}

/** `window.getSelection()` 的最小子集（不引入 DOM 类型，node 环境也能构造）。 */
export interface SelectionLike {
  readonly anchorNode: {
    readonly parentElement: { readonly closest: BlockElementLike["closest"] } | null;
  } | null;
  /** 焦点侧；`crossBlock` 用它比对**最近的块祖先**，而不是比节点身份（裁定 #11）。 */
  readonly focusNodeParent?: { readonly closest: BlockElementLike["closest"] } | null;
  readonly anchorOffset: number;
  readonly focusNode: unknown;
  readonly focusOffset: number;
}

/** 选区 → 描述（AC5.1）：没有块祖先就返回 `undefined`，其余判定交给 `selectionIntentOf`。 */
interface BlockLike {
  readonly textContent: string | null;
  readonly getAttribute: (name: string) => string | null;
}

const anchorBlockOf = (selection: SelectionLike | null): BlockLike | undefined => {
  const anchor = selection?.anchorNode;
  const element = anchor?.parentElement;
  if (
    selection === null ||
    anchor === null ||
    anchor === undefined ||
    element === null ||
    element === undefined
  ) {
    return undefined;
  }
  return element.closest("[data-hr-id]") ?? undefined;
};

/** 块内**字符**偏移的度量器（真实实现用 `Range.toString()` 的前后长度差，裁定 #11）。 */
export interface MeasureLike {
  readonly offsets: (selection: SelectionLike) => { readonly start: number; readonly end: number };
  readonly crossBlock: (selection: SelectionLike) => boolean;
}

/**
 * 选区 → 描述（AC5.1）。给了 `measure` 就用 Range 的字符偏移（支持反向拖拽）；
 * 没给就退回 anchor/focus 偏移（纯测/旧调用方仍可用）。
 */
export const rawSelectionOf = (
  selection: SelectionLike | null,
  measure?: MeasureLike,
): RawSelection | undefined => {
  const block = anchorBlockOf(selection);
  const anchor = selection?.anchorNode;
  if (
    block === undefined ||
    block.textContent === null ||
    selection === null ||
    anchor === null ||
    anchor === undefined
  ) {
    return undefined;
  }
  const offsets =
    measure === undefined
      ? { start: selection.anchorOffset, end: selection.focusOffset }
      : measure.offsets(selection);
  return {
    nodeId: block.getAttribute("data-hr-id") ?? "",
    blockText: block.textContent,
    start: offsets.start,
    end: offsets.end,
    crossBlock:
      measure === undefined ? anchor !== selection.focusNode : measure.crossBlock(selection),
  };
};
