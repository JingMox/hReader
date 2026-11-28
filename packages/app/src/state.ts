// 这层管：阅读器的全部状态与状态迁移（纯函数）。没有 DOM、没有计时器、没有 fetch：
// `reduce(state, intent)` 返回**同一引用**表示"什么都没变"，`store` 据此不通知订阅者。

import {
  initialNoteSlice,
  isDiffIntent,
  isNoteIntent,
  reduceDiff,
  reduceNote,
  type DiffIntent,
  type DiffSlice,
  type NoteIntent,
  type NoteSlice,
} from "./notes-state.ts";
import { closedDiff } from "./notes.ts";

export interface OutlineNode {
  readonly id: string;
  readonly level: number;
  readonly text: string;
  readonly children?: readonly OutlineNode[];
}

export type ConnState = "connecting" | "live" | "reconnecting" | "offline";

export type Panel = "closed" | "sidenote";

/** 演示模式的全部状态：只记"开没开 + 第几页"；页内步进是 DOM 事实，由 widget 自己记账。 */
export interface PresentMode {
  readonly active: boolean;
  /** 0 基页码；退出后保留，再次进入时续上。 */
  readonly page: number;
}

export interface ReaderState extends NoteSlice, DiffSlice {
  readonly docId: string;
  readonly revision: string;
  /** 真实生效的主题（`themeSettled ok:true` 才更新）。 */
  readonly theme: string;
  /** `<select>` 显示的主题：用户刚点的那个，失败时回退到 `theme`。 */
  readonly themeRequested: string;
  readonly outline: readonly OutlineNode[];
  /** 文档顺序的块 id（`data-hr-id`），`j`/`k` 与 TOC 高亮都按它走。 */
  readonly blocks: readonly string[];
  /** 演示页（文档序的 `data-hr-id`）：顶层 `h1`/`section`；两者都没有时退化为全部顶层块。 */
  readonly pages: readonly string[];
  readonly present: PresentMode;
  readonly activeId: string | undefined;
  readonly sidenoteId: string | undefined;
  readonly panel: Panel;
  readonly focus: boolean;
  readonly conn: ConnState;
  readonly searchOpen: boolean;
  readonly themePending: boolean;
  /** 沉浸模式：隐藏全部外壳（横幅/底栏/侧栏），只留阅读面；与演示态相互独立。 */
  readonly immersive: boolean;
  /** 最近一次取到的正文 HTML（块级 diff 的输入；`canvas` 用自己的 `revision` 记账）。 */
  readonly documentHtml: string;
  /** 最近一条 `doc.changed` 里点名的块（为空表示"整篇都可能变"）。 */
  readonly changedNodes: readonly string[];
}

export type ReaderIntent =
  | {
      readonly kind: "blocksLoaded";
      readonly blocks: readonly string[];
      readonly outline: readonly OutlineNode[];
      readonly revision?: string;
      readonly html?: string;
      /** 缺省表示"沿用现有页表"：首屏记账那次 dispatch 没有模型，不能清空页表。 */
      readonly pages?: readonly string[];
    }
  | { readonly kind: "outlineLoaded"; readonly outline: readonly OutlineNode[] }
  | { readonly kind: "move"; readonly delta: 1 | -1 }
  | { readonly kind: "scrollTo"; readonly id: string }
  | {
      readonly kind: "documentChanged";
      readonly revision: string;
      readonly blocks?: readonly string[];
      readonly changedNodes?: readonly string[];
      readonly html?: string;
    }
  | { readonly kind: "toggleFocus" }
  | { readonly kind: "openSidenote"; readonly id: string }
  | { readonly kind: "panelClosed" }
  | { readonly kind: "searchOpened" }
  | { readonly kind: "conn"; readonly conn: ConnState }
  | { readonly kind: "themeSelected"; readonly theme: string }
  | { readonly kind: "themeSettled"; readonly theme: string; readonly ok: boolean }
  | { readonly kind: "presentEntered"; readonly page?: number }
  | { readonly kind: "presentExited" }
  | { readonly kind: "presentMoved"; readonly page: number }
  | { readonly kind: "presentAdvanced" }
  | { readonly kind: "presentBack" }
  | { readonly kind: "immersiveToggled" }
  | NoteIntent
  | DiffIntent;

export const initialState = (docId: string, theme: string): ReaderState => ({
  ...initialNoteSlice,
  diff: closedDiff,
  docId,
  revision: "",
  theme,
  themeRequested: theme,
  outline: [],
  blocks: [],
  pages: [],
  present: { active: false, page: 0 },
  activeId: undefined,
  sidenoteId: undefined,
  panel: "closed",
  focus: false,
  conn: "connecting",
  searchOpen: false,
  themePending: false,
  immersive: false,
  documentHtml: "",
  changedNodes: [],
});

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((item, index) => item === b[index]);

/** 到头不循环：`j` 在最后一个块上原地不动（返回同一引用）。 */
const movedOf = (state: ReaderState, delta: 1 | -1): string | undefined => {
  const at = state.activeId === undefined ? -1 : state.blocks.indexOf(state.activeId);
  const next = at === -1 ? 0 : Math.min(state.blocks.length - 1, at + delta);
  if (at === -1) return state.blocks[0];
  if (delta === 1 && at >= state.blocks.length - 1) return undefined;
  if (delta === -1 && at <= 0) return undefined;
  return state.blocks[next];
};

const withPanel = (state: ReaderState, id: string): ReaderState => ({
  ...state,
  sidenoteId: id,
  panel: "sidenote",
  activeId: id,
});

type IntentOf<K extends ReaderIntent["kind"]> = Extract<ReaderIntent, { kind: K }>;

type DocIntent = IntentOf<"blocksLoaded"> | IntentOf<"documentChanged"> | IntentOf<"outlineLoaded">;
type NavIntent = IntentOf<"move"> | IntentOf<"scrollTo"> | IntentOf<"toggleFocus">;
type PanelIntent = IntentOf<"openSidenote"> | IntentOf<"panelClosed"> | IntentOf<"searchOpened">;

/** 页表收缩时把演示态收回合法区间：没有页就退出演示（空屏演示比"按了没反应"更糟）。 */
const presentOfPages = (present: PresentMode, pages: readonly string[]): PresentMode => {
  if (pages.length === 0) return present.active ? { ...present, active: false } : present;
  if (present.page < pages.length) return present;
  return { ...present, page: pages.length - 1 };
};

const reduceBlocks = (state: ReaderState, intent: IntentOf<"blocksLoaded">): ReaderState => {
  const pages = intent.pages ?? state.pages;
  const same =
    sameList(state.blocks, intent.blocks) &&
    state.outline === intent.outline &&
    sameList(state.pages, pages);
  const html = intent.html ?? state.documentHtml;
  const present = presentOfPages(state.present, pages);
  if (same && html === state.documentHtml && present === state.present) return state;
  return {
    ...state,
    revision: intent.revision ?? state.revision,
    blocks: intent.blocks,
    outline: intent.outline,
    pages,
    documentHtml: html,
    present,
    activeId: state.activeId ?? intent.blocks[0],
  };
};

const reduceChanged = (state: ReaderState, intent: IntentOf<"documentChanged">): ReaderState => {
  const blocks = intent.blocks ?? state.blocks;
  const activeStill = state.activeId !== undefined && blocks.includes(state.activeId);
  return {
    ...state,
    revision: intent.revision,
    blocks,
    documentHtml: intent.html ?? state.documentHtml,
    changedNodes: intent.changedNodes ?? [],
    activeId: activeStill ? state.activeId : blocks[0],
  };
};

const reduceOutline = (state: ReaderState, intent: IntentOf<"outlineLoaded">): ReaderState =>
  state.outline === intent.outline ? state : { ...state, outline: intent.outline };

const reduceDoc = (state: ReaderState, intent: DocIntent): ReaderState => {
  if (intent.kind === "outlineLoaded") return reduceOutline(state, intent);
  return intent.kind === "blocksLoaded"
    ? reduceBlocks(state, intent)
    : reduceChanged(state, intent);
};

const reduceNav = (state: ReaderState, intent: NavIntent): ReaderState => {
  if (intent.kind === "toggleFocus") return { ...state, focus: !state.focus };
  if (intent.kind === "scrollTo")
    return state.activeId === intent.id ? state : { ...state, activeId: intent.id };
  const next = movedOf(state, intent.delta);
  return next === undefined || next === state.activeId ? state : { ...state, activeId: next };
};

const reducePanel = (state: ReaderState, intent: PanelIntent): ReaderState => {
  if (intent.kind === "searchOpened")
    return state.searchOpen ? state : { ...state, searchOpen: true };
  if (intent.kind === "panelClosed")
    return state.panel === "closed" && !state.searchOpen
      ? state
      : { ...state, panel: "closed", searchOpen: false };
  return state.panel === "sidenote" && state.sidenoteId === intent.id
    ? state
    : withPanel(state, intent.id);
};

const reduceConn = (state: ReaderState, intent: IntentOf<"conn">): ReaderState =>
  state.conn === intent.conn ? state : { ...state, conn: intent.conn };

type PresentIntent =
  | IntentOf<"presentEntered">
  | IntentOf<"presentExited">
  | IntentOf<"presentMoved">
  | IntentOf<"presentAdvanced">
  | IntentOf<"presentBack">;

const isPresentIntent = (intent: ReaderIntent): intent is PresentIntent =>
  intent.kind === "presentEntered" ||
  intent.kind === "presentExited" ||
  intent.kind === "presentMoved" ||
  intent.kind === "presentAdvanced" ||
  intent.kind === "presentBack";

/** 页码恒收敛到 `[0, pages.length-1]`：Home/End 与越界 hash 共用这一个钳制点。 */
const clampPage = (state: ReaderState, page: number): number =>
  Math.min(Math.max(page, 0), state.pages.length - 1);

const reducePresent = (state: ReaderState, intent: PresentIntent): ReaderState => {
  if (intent.kind === "presentExited")
    return state.present.active
      ? { ...state, present: { ...state.present, active: false } }
      : state;
  if (intent.kind === "presentEntered") {
    // 没有可分页的内容就不进演示态——进了一块空屏比"按了没反应"更糟。
    if (state.pages.length === 0 || state.present.active) return state;
    return {
      ...state,
      present: { active: true, page: clampPage(state, intent.page ?? state.present.page) },
    };
  }
  if (!state.present.active) return state;
  const target =
    intent.kind === "presentMoved"
      ? intent.page
      : intent.kind === "presentAdvanced"
        ? state.present.page + 1
        : state.present.page - 1;
  const page = clampPage(state, target);
  return page === state.present.page ? state : { ...state, present: { ...state.present, page } };
};

const reduceTheme = (
  state: ReaderState,
  intent: IntentOf<"themeSelected"> | IntentOf<"themeSettled">,
): ReaderState => {
  if (intent.kind === "themeSelected") {
    return state.themePending || state.themeRequested === intent.theme
      ? state
      : { ...state, themePending: true, themeRequested: intent.theme };
  }
  // 成功：已应用主题跟上；失败：下拉回退到真实生效的那个（不写死默认名）。
  return intent.ok
    ? { ...state, themePending: false, theme: intent.theme, themeRequested: intent.theme }
    : { ...state, themePending: false, themeRequested: state.theme };
};

const isDocIntent = (intent: ReaderIntent): intent is DocIntent =>
  intent.kind === "blocksLoaded" ||
  intent.kind === "documentChanged" ||
  intent.kind === "outlineLoaded";

const isNavIntent = (intent: ReaderIntent): intent is NavIntent =>
  intent.kind === "move" || intent.kind === "scrollTo" || intent.kind === "toggleFocus";

const isPanelIntent = (intent: ReaderIntent): intent is PanelIntent =>
  intent.kind === "openSidenote" || intent.kind === "panelClosed" || intent.kind === "searchOpened";

/** 顶层只做"分派到小组"，每个小组的 switch/分支复杂度因此各自可控。 */
export const reduce = (state: ReaderState, intent: ReaderIntent): ReaderState => {
  if (isDocIntent(intent)) return reduceDoc(state, intent);
  if (isNoteIntent(intent)) {
    const next = reduceNote(state, intent);
    return next === state ? state : { ...state, ...next };
  }
  if (isDiffIntent(intent)) {
    const next = reduceDiff(state, intent);
    return next === state ? state : { ...state, ...next };
  }
  if (isNavIntent(intent)) return reduceNav(state, intent);
  if (isPanelIntent(intent)) return reducePanel(state, intent);
  if (isPresentIntent(intent)) return reducePresent(state, intent);
  if (intent.kind === "immersiveToggled") return { ...state, immersive: !state.immersive };
  if (intent.kind === "conn") return reduceConn(state, intent);
  return reduceTheme(state, intent);
};
