// 这层管：`Range` 的最小包装（块内字符偏移与跨块判定）。
// 放独立文件：`Range` 的适配只有划词链路需要，`main.ts` 不必背这份声明。

import type { DocumentLike } from "./dom.ts";
import type { BlockElementLike, MeasureLike } from "./widgets/selection.ts";

declare const document: DocumentLike;
declare const window: {
  readonly getSelection?: () => {
    readonly rangeCount?: number;
    readonly getRangeAt?: (index: number) => {
      readonly startContainer: unknown;
      readonly startOffset: number;
      readonly endContainer: unknown;
      readonly endOffset: number;
    };
  } | null;
};

const blockOf = (
  element: { readonly closest: BlockElementLike["closest"] } | null | undefined,
): { readonly textContent: string | null } | null => element?.closest("[data-hr-id]") ?? null;

const rangeOf = ():
  | {
      readonly startContainer: unknown;
      readonly startOffset: number;
      readonly endContainer: unknown;
      readonly endOffset: number;
    }
  | undefined => {
  const sel = window.getSelection?.();
  if (sel?.getRangeAt === undefined) return undefined;
  return sel.rangeCount === 0 ? undefined : sel.getRangeAt(0);
};

export const measureSelection = (): MeasureLike => ({
  offsets: (selection) => {
    const range = rangeOf();
    const factory = document.createRange;
    const block = blockOf(selection.anchorNode?.parentElement ?? null);
    if (range === undefined || factory === undefined || block === null) return { start: 0, end: 0 };
    const measure = (node: unknown, offset: number): number => {
      const head = factory.call(document);
      head.selectNodeContents(block);
      head.setEnd(node, offset);
      return head.toString().length;
    };
    const left = measure(range.startContainer, range.startOffset);
    const right = measure(range.endContainer, range.endOffset);
    return left <= right ? { start: left, end: right } : { start: right, end: left };
  },
  crossBlock: (selection) => {
    const focus = selection.focusNodeParent ?? selection.focusNode?.parentElement;
    const focusBlock = focus === undefined || focus === null ? null : blockOf(focus);
    return blockOf(selection.anchorNode?.parentElement ?? null) !== focusBlock;
  },
});
