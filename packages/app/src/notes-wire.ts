// 这层管：批注/diff 的**接线细节**（DOM 事件 + 单出口副作用 + 右栏渲染）。
// `boot` 只有两个出口：`before(intent)` 在 dispatch **前**求值（守卫用），`after(intent)` 在 dispatch **后**（渲染用）。
// 两者职责写在这里，避免再出现"守卫读到 dispatch 之后的状态"。

import type { Host, TargetLike } from "./dom.ts";
import { escapeAttr } from "./escape-attr.ts";
import {
  annotationIntentOf,
  renderAnnotations,
  renderDiff,
  revertOf,
  submitAnnotationOf,
} from "./wiring.ts";
import type { AppIo } from "./io.ts";
import type { RawSelection } from "./widgets/selection.ts";
import { optimisticCardOf, type AnnotationCard, type NoteAnchor } from "./notes.ts";
import { withLost } from "./notes-state.ts";
import type { ReaderIntent, ReaderState } from "./state.ts";
import type { Store } from "./store.ts";

/** 带 try/catch 的选择器：非法 id 一律"找不到"，绝不让异常逃到回调外。 */
const foundNodeOf = (host: Host, id: string): string | undefined => {
  try {
    return host.has?.(`#hr-root [data-hr-id="${escapeAttr(id)}"]`) === true ? id : undefined;
  } catch {
    return undefined;
  }
};

/** 批注相关的 IO 与文本源：全部注入，`boot` 只做接线。 */
export interface NotesDeps {
  readonly io: AppIo;
  readonly fetchAnnotations: () => Promise<{
    readonly annotations: readonly AnnotationCard[];
    readonly lost?: readonly string[];
    /** 脏 meta 的人话诊断：`load` 把它们拼进 `noteError`。 */
    readonly diagnostics?: readonly string[];
  }>;
  /** 服务端算好的 diff（浏览器里不再有第二套算法）。 */
  readonly fetchDiff?: (annotationId: string) => Promise<{
    /**
     * **当前文档**里这块的真实 id（`contracts.ts` 的 `AnnotationDiffBody.nodeId`）：重识别成功后与
     * 批注记录的旧 id 不同。面板按它标块，所以它只认响应，不认本地 `activeId`。
     */
    readonly nodeId: string;
    readonly chunks: readonly { readonly kind: "same" | "ins" | "del"; readonly text: string }[];
    readonly degraded: boolean;
    readonly degradedReason?: string;
  }>;
  readonly textOf: (id: string) => string | undefined;
}

const ROOT = "#hr-root";

const noteAnchorOfWorkable = (
  deps: NotesDeps,
  store: Store,
):
  | {
      readonly nodeId: string;
      readonly anchor: {
        readonly exact: string;
        readonly prefix: string;
        readonly suffix: string;
        readonly start: number;
      };
    }
  | undefined => {
  const id = store.get().activeId;
  if (id === undefined) return undefined;
  const text = deps.textOf(id);
  if (text === undefined || text.trim() === "") return undefined;
  return { nodeId: id, anchor: { exact: text, prefix: "", suffix: "", start: 0 } };
};

interface NotesScope {
  readonly host: Host;
  readonly notes: NotesDeps;
  readonly reload: () => Promise<void>;
  readonly store: Store;
  readonly pump: (task: () => Promise<void>) => void;
  readonly dispatch: (intent: ReaderIntent) => void;
}

/** 提交的唯一出口：乐观卡 → POST → 成功换真卡 / 失败回滚 + 提示。 */
const submitFlow =
  (scope: NotesScope): ((card: AnnotationCard, anchor?: NoteAnchor) => void) =>
  (card, anchor) => {
    const { notes, store } = scope;
    scope.pump(async () => {
      try {
        await submitAnnotationOf(notes.io, store.get().docId, {
          nodeId: card.nodeId,
          note: card.note,
          ...(anchor === undefined ? {} : { anchor }),
        });
        // POST 成功 ≠ 右栏已刷新：保持 `optimistic:true`，先只结束“提交中”，
        // 再由 `reload` 用服务端卡替换乐观卡（`listOf` 按同块同文认领）；
        // 提前翻成确认卡的话，reload 失败时那张 `tmp-*` 卡就永远删不掉了。
        store.dispatch({ kind: "noteSettled", ok: true });
        await scope.reload();
      } catch (error: unknown) {
        store.dispatch({
          kind: "noteSettled",
          ok: false,
          message: error instanceof Error ? error.message : "提交失败",
        });
      }
    });
  };

/** 聚焦一张批注卡：先派 `annotationOpened`（意图出口唯一），再把锚点块滚进视野并标记。
 *  卡片点击与「搜索命中 → 同文档批注」共用这一条路径（D61 搜索面板也调它）。 */
export const focusAnnotationCard = (
  scope: {
    readonly host: Host;
    readonly store: Store;
    readonly dispatch: (intent: ReaderIntent) => void;
  },
  id: string,
): void => {
  const { host, store, dispatch } = scope;
  dispatch({ kind: "annotationOpened", id });
  const card = store.get().annotations.find((item) => item.id === id);
  if (card === undefined || card.lost !== undefined) return;
  const target = foundNodeOf(host, card.nodeId);
  if (target === undefined) return;
  host.scrollTo(`${ROOT} [data-hr-id="${escapeAttr(target)}"]`);
  host.cls(`${ROOT} [data-hr-id="${escapeAttr(target)}"]`, "hr-note-target", true);
};

const wireNotesDom = (host: Host, store: Store, dispatch: (intent: ReaderIntent) => void): void => {
  host.on(`${ROOT} #hr-note-btn`, "click", () => {
    dispatch({ kind: "annotateButton" });
  });
  host.on(`${ROOT} #hr-note-cancel`, "click", () => {
    dispatch({ kind: "annotateCancel" });
  });
  host.on(`${ROOT} #hr-note-draft`, "input", (event) => {
    dispatch({ kind: "noteChanged", text: event.value ?? "" });
  });
  const onCardClick = (event: TargetLike): void => {
    const id = event.closest?.("[data-hr-annotation]")?.getAttribute("data-hr-annotation");
    if (id === null || id === undefined) return;
    focusAnnotationCard({ host, store, dispatch }, id);
  };
  host.on(`${ROOT} #hr-notes-body`, "click", onCardClick);
  host.on(`${ROOT} #hr-notes-pending`, "click", onCardClick);
  host.on(`${ROOT} #hr-notes-resolved`, "click", onCardClick);
};

const wireSubmit = (
  host: Host,
  store: Store,
  dispatch: (intent: ReaderIntent) => void,
  submit: (card: AnnotationCard, anchor?: NoteAnchor) => void,
): void => {
  host.on(`${ROOT} #hr-note-submit`, "click", () => {
    // 提交按钮的可用性取决于 draft；空草稿不发请求。
    const state = store.get();
    const note = state.noteDraft.trim();
    const target = state.noteTarget;
    if (target === undefined || note === "") return;
    const card = optimisticCardOf(target, note, state.noteSeq);
    // 先发 `noteSubmitted`（乐观卡/关编辑器/清草稿/`noteBusy`/`noteSeq` 全在 reducer 里）再走 IO；
    // 锚点必须在 dispatch **前**抓住——reducer 会把 `noteTarget` 清掉。
    dispatch({ kind: "noteSubmitted", card });
    submit(card, target.anchor);
  });
};

/** 状态 → 右栏：批注两组 + diff 面板；正文 DOM 一概不碰。 */
export const renderNotes = (host: Host, state: ReaderState): void => {
  renderAnnotations(host, ROOT, state.annotations);
  host.text(`${ROOT} #hr-note-draft`, state.noteDraft);
  // 空态写空串（不是 "undefined"）：错误元素常驻，只换文本。
  host.text(`${ROOT} #hr-note-error`, state.noteError ?? "");
  const { diff } = state;
  if (!diff.open) return;
  renderDiff(host, ROOT, {
    nodeId: diff.nodeId,
    chunks: diff.chunks,
    degraded: diff.degraded,
    ...(diff.reason === undefined ? {} : { reason: diff.reason }),
  });
};

interface NotesWire {
  readonly submit: (card: AnnotationCard, anchor?: NoteAnchor) => void;
  /** dispatch **前**：只答"这个意图让不让过"。 */
  readonly before: (intent: ReaderIntent) => boolean;
  /** dispatch **后**：只做副作用与渲染（同一意图只调一次）。 */
  readonly after: (intent: ReaderIntent) => void;
  readonly wireDom: () => void;
  readonly load: () => Promise<void>;
  readonly selection: (raw: RawSelection) => void;
}

const revertFlow = (scope: NotesScope): (() => void) => {
  // 面板要等成功才关（失败不该假装已关），所以飞行中的重复 `w` 在这里挡掉。
  let inFlight = false;
  return () => {
    if (inFlight) return;
    inFlight = true;
    scope.pump(async () => {
      try {
        await revertOf(scope.notes.io, scope.store.get().docId);
        // 撤销成功后先关面板：再按 `w` 会摸到观众看不见的下一个 revision。
        if (scope.store.get().diff.open) scope.store.dispatch({ kind: "diffToggled" });
        await scope.reload();
      } finally {
        inFlight = false;
      }
    });
  };
};

const diffFlow =
  (scope: NotesScope): (() => void) =>
  () => {
    const { notes, store } = scope;
    // `activeId` 只用来挑"当前块上的那条批注"；标哪一块由服务端响应决定（见下）。
    const activeId = store.get().activeId;
    const fetchDiff = notes.fetchDiff;
    if (activeId === undefined || fetchDiff === undefined) return;
    const card = store
      .get()
      .annotations.find((item) => item.nodeId === activeId && item.lost === undefined);
    if (card === undefined) return;
    scope.pump(async () => {
      const diff = await fetchDiff(card.id);
      // 用响应里的权威 id：重识别后它和批注记录的旧 id 不同，拿本地 `activeId` 会标到已不在 DOM 的块上。
      store.dispatch({
        kind: "diffShown",
        nodeId: diff.nodeId,
        chunks: diff.chunks,
        degraded: diff.degraded,
        ...(diff.degradedReason === undefined ? {} : { reason: diff.degradedReason }),
      });
    });
  };

/** 划词命中就有可见反馈：给那个块挂 `hr-note-target`，否则用户不知道自己选到了哪。 */
const highlightBlock = (scope: NotesScope, nodeId: string): void => {
  const target = foundNodeOf(scope.host, nodeId);
  if (target !== undefined) {
    scope.host.cls(`${ROOT} [data-hr-id="${escapeAttr(target)}"]`, "hr-note-target", true);
  }
};

const afterOf = (scope: NotesScope): ((intent: ReaderIntent) => void) => {
  const revert = revertFlow(scope);
  const openDiff = diffFlow(scope);
  return (intent) => {
    if (intent.kind === "selectionMade") highlightBlock(scope, intent.nodeId);
    if (intent.kind === "diffToggled" && !scope.store.get().diff.open) openDiff();
    if (intent.kind === "revert") revert();
    if (intent.kind === "openSidenote") {
      const anchor = noteAnchorOfWorkable(scope.notes, scope.store);
      if (anchor === undefined) return;
      scope.store.dispatch({ kind: "selectionMade", ...anchor });
      scope.store.dispatch({ kind: "annotateButton" });
    }
  };
};

/** `w` 只在 diff 面板开着时生效——判定必须在 dispatch 之前读到真状态。 */
const beforeOf = (scope: NotesScope): ((intent: ReaderIntent) => boolean) => {
  return (intent) => intent.kind !== "revert" || scope.store.get().diff.open;
};

export const wireNotes = (scope: NotesScope): NotesWire => {
  const { host, store, dispatch } = scope;
  const submit = submitFlow(scope);
  return {
    submit,
    before: beforeOf(scope),
    after: afterOf(scope),
    wireDom: () => {
      wireNotesDom(host, store, dispatch);
      wireSubmit(host, store, dispatch, submit);
    },
    load: async () => {
      const loaded = await scope.notes.fetchAnnotations();
      store.dispatch({
        kind: "annotationsLoaded",
        list: withLost(loaded.annotations, loaded.lost ?? []),
      });
      const diagnostics = loaded.diagnostics ?? [];
      // 脏 meta 的后果是"批注变少"，不提示就只是一次悄无声息的丢失。
      if (diagnostics.length > 0) {
        store.dispatch({ kind: "noteError", message: diagnostics.join("；") });
      }
    },
    selection: (raw) => {
      const intent = annotationIntentOf(raw);
      if (intent.kind === "crossBlock") {
        // 跨块锚定是下一版的事，但"选到了却什么都不发生"是缺陷：给一条可见提示。
        dispatch({ kind: "noteError", message: "跨块选区只支持块内批注：请只选一个段落内的文字" });
        return;
      }
      if (intent.kind !== "annotate") return;
      // 必须走 `dispatchIntent`（而不是直接 `store.dispatch`），否则 `after` 里的高亮不会执行。
      dispatch({ kind: "selectionMade", nodeId: intent.nodeId, anchor: intent.anchor });
    },
  };
};
