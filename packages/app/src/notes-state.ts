// 这层管：批注与 diff 的状态迁移（纯函数，同引用表示无变化）；由 `state.ts` 按 intent 分派。
// 拆成独立文件是为了让 `state.ts` 守住 `max-lines: 300` 与 `complexity: 10`。

import {
  closedDiff,
  withoutOptimistic,
  type AnnotationCard,
  type DiffState,
  type NoteAnchor,
  type NoteTarget,
} from "./notes.ts";

export interface NoteSlice {
  readonly annotations: readonly AnnotationCard[];
  readonly noteTarget: NoteTarget | undefined;
  readonly noteDraft: string;
  readonly noteError: string | undefined;
  readonly noteBusy: boolean;
  readonly noteSeq: number;
  readonly noteEditorOpen: boolean;
}

export const initialNoteSlice: NoteSlice = {
  annotations: [],
  noteTarget: undefined,
  noteDraft: "",
  noteError: undefined,
  noteBusy: false,
  noteSeq: 0,
  noteEditorOpen: false,
};

export type NoteIntent =
  | { readonly kind: "annotateStart"; readonly nodeId: string; readonly anchor: NoteAnchor }
  | { readonly kind: "selectionMade"; readonly nodeId: string; readonly anchor: NoteAnchor }
  | { readonly kind: "annotateButton" }
  | { readonly kind: "annotateCancel" }
  | { readonly kind: "noteChanged"; readonly text: string }
  /** 用户可见的批注提示（跨块选区等"不能批注但要说清楚"的情况）；不是提交失败。 */
  | { readonly kind: "noteError"; readonly message: string }
  | { readonly kind: "noteSubmitted"; readonly card: AnnotationCard }
  | {
      readonly kind: "noteSettled";
      readonly ok: boolean;
      readonly message?: string;
    }
  | { readonly kind: "annotationsLoaded"; readonly list: readonly AnnotationCard[] }
  | { readonly kind: "annotationOpened"; readonly id: string };

export type DiffIntent =
  | { readonly kind: "diffToggled" }
  | {
      readonly kind: "diffShown";
      readonly nodeId: string;
      readonly chunks: DiffState["chunks"];
      readonly degraded: boolean;
      readonly reason?: string;
    }
  | { readonly kind: "revert" };

const NOTE_KINDS: readonly string[] = [
  "annotateStart",
  "selectionMade",
  "annotateButton",
  "annotateCancel",
  "noteChanged",
  "noteError",
  "noteSubmitted",
  "noteSettled",
  "annotationsLoaded",
  "annotationOpened",
];

const DIFF_KINDS: readonly string[] = ["diffToggled", "diffShown", "revert"];

export const isNoteIntent = (intent: { readonly kind: string }): intent is NoteIntent =>
  NOTE_KINDS.includes(intent.kind);

export const isDiffIntent = (intent: { readonly kind: string }): intent is DiffIntent =>
  DIFF_KINDS.includes(intent.kind);

/** 已加载的批注 + `lost` 的 id 列表 → 标灰的卡片（只标不改数据）。 */
export const withLost = (
  cards: readonly AnnotationCard[],
  lostIds: readonly string[],
): readonly AnnotationCard[] =>
  cards.map((card) =>
    lostIds.includes(card.id) && card.lost === undefined ? { ...card, lost: "anchor_lost" } : card,
  );

/** 乐观卡认领服务端卡的键：POST 只回 `revision`（不返回 id），只能用“同块同文”认领。 */
const keyOf = (card: AnnotationCard): string => `${card.nodeId}\u0000${card.note}`;

/**
 * 整表落地时：服务端卡优先（乐观卡让位），还没有对应物的乐观卡必须留住
 * —— POST resolve 前它只存在于本地，不能被首屏清单覆盖。
 */
const pendingOf = (
  state: NoteSlice,
  list: readonly AnnotationCard[],
): readonly AnnotationCard[] => {
  const spare = new Map<string, number>();
  for (const card of list) spare.set(keyOf(card), (spare.get(keyOf(card)) ?? 0) + 1);
  return state.annotations.filter((card) => {
    if (card.optimistic !== true) return false;
    const left = spare.get(keyOf(card)) ?? 0;
    if (left === 0) return true;
    spare.set(keyOf(card), left - 1);
    return false;
  });
};

const listOf = (state: NoteSlice, list: readonly AnnotationCard[]): NoteSlice => {
  const pending = pendingOf(state, list);
  if (pending.length === 0) {
    return state.annotations === list ? state : { ...state, annotations: list };
  }
  return { ...state, annotations: [...list, ...pending] };
};

const startOf = (state: NoteSlice, target: NoteTarget): NoteSlice => {
  const same =
    state.noteTarget?.nodeId === target.nodeId &&
    state.noteTarget.anchor.start === target.anchor.start &&
    state.noteTarget.anchor.exact === target.anchor.exact;
  return same ? state : { ...state, noteTarget: target, noteDraft: "", noteError: undefined };
};

const submittedOf = (state: NoteSlice, card: AnnotationCard): NoteSlice => ({
  ...state,
  annotations: [...state.annotations, card],
  noteTarget: undefined,
  noteDraft: "",
  noteError: undefined,
  noteBusy: true,
  noteSeq: state.noteSeq + 1,
  noteEditorOpen: false,
});

const settledOf = (
  state: NoteSlice,
  intent: Extract<NoteIntent, { kind: "noteSettled" }>,
): NoteSlice => {
  if (intent.ok) {
    // 成功只结束“提交中”：乐观卡**不**在这里转正——真卡由随后的 `reload` 落地。
    // 先转正再 reload 失败的话，那张 `tmp-*` 卡既删不掉（已不属未确认），点它还必然 404。
    return state.noteBusy ? { ...state, noteBusy: false, noteError: undefined } : state;
  }
  return {
    ...state,
    annotations: withoutOptimistic(state.annotations),
    noteBusy: false,
    noteError: intent.message ?? "提交失败",
  };
};

const panelOf = (state: NoteSlice, intent: NoteIntent): NoteSlice => {
  if (intent.kind !== "annotateCancel") {
    return state.noteTarget === undefined || state.noteEditorOpen
      ? state
      : { ...state, noteEditorOpen: true };
  }
  return state.noteTarget === undefined && !state.noteEditorOpen
    ? state
    : {
        ...state,
        noteTarget: undefined,
        noteDraft: "",
        noteEditorOpen: false,
        noteError: undefined,
      };
};

/** 草稿 / 可见提示（同值返回同引用）。 */
const draftOf = (state: NoteSlice, text: string): NoteSlice =>
  state.noteDraft === text ? state : { ...state, noteDraft: text };

const noticeOf = (state: NoteSlice, message: string): NoteSlice =>
  state.noteError === message ? state : { ...state, noteError: message };

/** 提交的乐观落态与收尾（成功/失败）。参数与返回都是 `NoteSlice`：`reduceNote` 已经把其余 kind 都提前返回掉，这里不可能"不处理"。 */
const outcomeOf = (
  state: NoteSlice,
  intent: Extract<
    NoteIntent,
    { readonly kind: "noteSubmitted" } | { readonly kind: "noteSettled" }
  >,
): NoteSlice => {
  if (intent.kind === "noteSubmitted") return submittedOf(state, intent.card);
  return settledOf(state, intent);
};

export const reduceNote = (state: NoteSlice, intent: NoteIntent): NoteSlice => {
  if (intent.kind === "annotateStart") {
    return {
      ...startOf(state, { nodeId: intent.nodeId, anchor: intent.anchor }),
      noteEditorOpen: true,
    };
  }
  if (intent.kind === "selectionMade") {
    return startOf(state, { nodeId: intent.nodeId, anchor: intent.anchor });
  }
  if (intent.kind === "annotateButton" || intent.kind === "annotateCancel") {
    return panelOf(state, intent);
  }
  if (intent.kind === "annotationOpened") return state;
  if (intent.kind === "noteChanged") return draftOf(state, intent.text);
  if (intent.kind === "noteError") return noticeOf(state, intent.message);
  // 到此 intent 只剩两种 kind（上面的提前返回就是穷尽性证明）：多一种 kind 会在这里编译错。
  return intent.kind === "annotationsLoaded"
    ? listOf(state, intent.list)
    : outcomeOf(state, intent);
};

export interface DiffSlice {
  readonly diff: DiffState;
}

/** `diffToggled` 由 `notes-wire.ts` 的 `afterOf` 取回服务端结果后再发 `diffShown`；这里只负责开/关的落态（同引用=无变化）。 */
export const reduceDiff = (state: DiffSlice, intent: DiffIntent): DiffSlice => {
  if (intent.kind === "diffShown") {
    return {
      ...state,
      diff: {
        open: true,
        nodeId: intent.nodeId,
        chunks: intent.chunks,
        degraded: intent.degraded,
        ...(intent.reason === undefined ? {} : { reason: intent.reason }),
      },
    };
  }
  if (intent.kind === "diffToggled") {
    return state.diff.open ? { ...state, diff: closedDiff } : state;
  }
  return state;
};
