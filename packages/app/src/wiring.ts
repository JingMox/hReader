// 这层管：浏览器侧的接线（state → DOM 全量同步 + 右栏批注/diff 渲染 + 两个写请求 + `keydown` 事件源适配）；
// 渲染全是纯函数，IO 注入。
// 从 `main.ts` / `boot.ts` 拆出来：入口只留装配，渲染与状态同步归这里。

import type { AppIo, RevisionResponse } from "./io.ts";
import type { Host } from "./dom.ts";
import { escapeAttr } from "./escape-attr.ts";
import type { KeyLike } from "./keys.ts";
import type { ReaderState } from "./state.ts";
import type { Widget } from "./widgets/library.ts";
import { annotationSpecsOf, type AnnotationView } from "./widgets/sidenotes.ts";
import { diffSpecsOf, diffStatusOf, type DiffView } from "./widgets/diffview.ts";
import { selectionIntentOf, type RawSelection, type SelectionIntent } from "./widgets/selection.ts";

const ROOT = "#hr-root";

/** 真 `keydown` 的最小视图：读 `key`/`metaKey`/`ctrlKey`/`altKey`/`shiftKey` 五项 + `target`（`tagName`/`isContentEditable`）。清单以 `keys.ts` 的 `KeyLike` 为唯一标准——少转发一个，就有快捷键从真实入口永久不可达（曾漏 `shiftKey`，Shift+D 产不出 `diffToggled`）；`keys.ts` 新读字段时必须同步这里与 `keySourceOf`。 */
export interface KeyboardLike {
  readonly key: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  readonly target?: { readonly tagName?: string; readonly isContentEditable?: boolean } | null;
  /** 原型链方法，必须包一层转发（`this` 丢不得）。 */
  readonly preventDefault?: () => void;
}

/** 浏览器全局的最小声明（本仓库 tsconfig 不带 DOM lib）：本文件的键盘源只用到这两个成员。 */
declare const window: {
  readonly addEventListener: (type: string, listener: (event: KeyboardLike) => void) => void;
  readonly removeEventListener: (type: string, listener: (event: KeyboardLike) => void) => void;
};

/** `window` 的 `keydown` → `KeyLike`（`boot` 只认注入的这个函数）。 */
export const keySourceOf = (handler: (event: KeyLike) => void): (() => void) => {
  const listener = (event: KeyboardLike): void => {
    handler({
      key: event.key,
      metaKey: event.metaKey === true,
      ctrlKey: event.ctrlKey === true,
      altKey: event.altKey === true,
      shiftKey: event.shiftKey === true,
      target: event.target ?? null,
      preventDefault: () => {
        event.preventDefault?.();
      },
    });
  };
  window.addEventListener("keydown", listener);
  return () => {
    window.removeEventListener("keydown", listener);
  };
};

const isRevisionResponse = (value: unknown): value is RevisionResponse =>
  typeof value === "object" && value !== null && typeof Reflect.get(value, "revision") === "string";

/** 右栏批注两组：`pending` / `resolved`。 */
export const renderAnnotations = (
  host: Host,
  parent: string,
  view: readonly AnnotationView[],
): void => {
  const specs = annotationSpecsOf(view);
  host.children(`${parent} #hr-notes-pending`, specs.pending);
  host.children(`${parent} #hr-notes-resolved`, specs.resolved);
};

/** Diff 面板：只往右栏写，正文 DOM 一概不碰。 */
export const renderDiff = (host: Host, parent: string, view: DiffView): void => {
  host.children(`${parent} #hr-diff-chunks`, diffSpecsOf(view));
  host.text(`${parent} #hr-diff-status`, diffStatusOf(view));
};

/**
 * 状态 → 渲染的一次同步（只读 state，不做 IO）。`renderNotes` 由 `boot` 注入：
 * 本文件不能反向引用 `notes-wire.ts`（它 import 本文件的渲染函数，会成环）。
 */
export const syncView = (view: {
  readonly host: Host;
  readonly widgets: readonly Widget[];
  /** 缺省 = 批注层没接。 */
  readonly renderNotes?: (state: ReaderState) => void;
}): ((next: ReaderState) => void) => {
  const { host, widgets, renderNotes } = view;
  return (next: ReaderState): void => {
    for (const widget of widgets) widget.update(next);
    renderNotes?.(next);
    host.cls(`${ROOT} #hr-notes`, "sidenotes--open", next.panel === "sidenote" || next.diff.open);
    host.cls(`${ROOT} #hr-note-editor`, "sidenote-editor--open", next.noteEditorOpen);
    host.cls(`${ROOT} #hr-diff`, "diff--open", next.diff.open);
    // `#hr-note-btn` 首帧在模板里带 `hidden`（无 JS 时的兜底）；摘除/复原的唯一责任点就在这里：
    // 有选区（`noteTarget` 已设）→ 摘掉，选区取消/提交后 → 带回来。不靠 CSS 覆盖 `[hidden]`。
    host.attr(`${ROOT} #hr-note-btn`, "hidden", next.noteTarget === undefined ? "" : undefined);
    // `hr-note-target` 描边同一条事实源：选区没了就全量扫掉——先后划过几个块会留好几处
    // 橙框，`cls` 只改第一个命中，必须按 `data-hr-id` 逐块点名。
    if (next.noteTarget === undefined) {
      for (const element of host.all(`${ROOT} .hr-note-target`)) {
        const id = element.getAttribute("data-hr-id");
        if (id !== null)
          host.cls(`${ROOT} [data-hr-id="${escapeAttr(id)}"]`, "hr-note-target", false);
      }
    }
  };
};

/** Diff 的 Revert：只发一次 undo，正文由随后的 `doc.changed` 刷回。 */
export const revertOf = async (io: AppIo, docId: string): Promise<RevisionResponse> => {
  if (io.post === undefined) throw new Error("当前 IO 未实现写请求（POST）");
  return await io.post(`/api/doc/${encodeURIComponent(docId)}/undo`, {}, isRevisionResponse);
};

/** 提交批注：失败时调用方把乐观渲染的那条撤回。 */
export const submitAnnotationOf = async (
  io: AppIo,
  docId: string,
  body: Readonly<Record<string, unknown>>,
): Promise<RevisionResponse> => {
  if (io.post === undefined) throw new Error("当前 IO 未实现写请求（POST）");
  return await io.post(
    `/api/doc/${encodeURIComponent(docId)}/annotations`,
    body,
    isRevisionResponse,
  );
};

/** 划词 → intent：写盘由 `annotationOps` 负责，这里只产出描述。 */
export const annotationIntentOf = (selection: RawSelection): SelectionIntent =>
  selectionIntentOf(selection);
