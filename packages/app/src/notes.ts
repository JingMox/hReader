// 这层管：批注与 diff 的**数据类型 + 纯辅助**（无 DOM、无 IO、无计时器）。
// state.ts / notes-state.ts / boot.ts / widgets 都只依赖本文件的类型与纯函数，互相不引用。

export type AnnotationStatus = "pending" | "resolved";

/** 锚点失效的两种原因：块被删 / 正文改写。 */
export type AnnotationLost = "anchor_lost" | "orphaned";

/** 右栏一张卡。`optimistic` = 已乐观渲染、服务端还没确认。 */
export interface AnnotationCard {
  readonly id: string;
  readonly nodeId: string;
  readonly note: string;
  readonly status: AnnotationStatus;
  readonly resolvedAt?: string;
  readonly resolutionNote?: string;
  readonly lost?: AnnotationLost;
  readonly optimistic?: boolean;
}

/** 划词得到的锚点（与 `@hreader/core` 的 `TextAnchor` 同构；app 不依赖 core）。 */
export interface NoteAnchor {
  readonly exact: string;
  readonly prefix: string;
  readonly suffix: string;
  readonly start: number;
}

/** 待提交的批注：锚点 + 输入框里的草稿。 */
export interface NoteTarget {
  readonly nodeId: string;
  readonly anchor: NoteAnchor;
}

type DiffKind = "same" | "ins" | "del";

export interface DiffChunk {
  readonly kind: DiffKind;
  readonly text: string;
}

/** 关着时 `nodeId` 是空串（哨兵值），渲染侧因此不需要 `?? ""` 兜底。 */
export interface DiffState {
  readonly open: boolean;
  readonly nodeId: string;
  readonly chunks: readonly DiffChunk[];
  readonly degraded: boolean;
  /** 退化的原因（服务端给，如"历史里找不到该块"）；没有就用通用文案。 */
  readonly reason?: string;
}

export const closedDiff: DiffState = { open: false, nodeId: "", chunks: [], degraded: false };

/** 乐观卡的 id：`tmp-` 前缀保证不会与服务端的 `an-…` 撞（回滚时按它删）。 */
export const optimisticCardOf = (
  target: NoteTarget,
  note: string,
  seq: number,
): AnnotationCard => ({
  id: `tmp-${String(seq)}`,
  nodeId: target.nodeId,
  note,
  status: "pending",
  optimistic: true,
});

/** 失败回滚：只删乐观卡，别的卡原样。 */
export const withoutOptimistic = (cards: readonly AnnotationCard[]): readonly AnnotationCard[] =>
  cards.filter((card) => card.optimistic !== true);
