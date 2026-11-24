// 这层管：键盘 → Intent 的纯映射（不读 `document`/`window`）。`KeyLike` 只带单键判定需要的东西，
// 因此「焦点在输入框里不触发单键快捷键」这一条也能被纯函数测到（`target` 的标签名由调用方给）。

import type { ReaderIntent, ReaderState } from "./state.ts";

export interface KeyTargetLike {
  readonly tagName?: string;
  readonly isContentEditable?: boolean;
}

export interface KeyLike {
  readonly key: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  readonly target?: KeyTargetLike | null;
  /** 事件被消费时由 `boot` 调一次：方向键/空格/F5 不拦，浏览器会先翻页或刷新。 */
  readonly preventDefault?: () => void;
}

const EDITABLE_TAGS: readonly string[] = ["INPUT", "TEXTAREA", "SELECT"];

/** 有修饰键就不是单键命令：⌘J / Ctrl+K 留给浏览器与未来的面板搜索。 */
const modified = (event: KeyLike): boolean =>
  event.metaKey === true || event.ctrlKey === true || event.altKey === true;

const isEditableTarget = (target: KeyTargetLike | null | undefined): boolean =>
  target !== null &&
  target !== undefined &&
  (target.isContentEditable === true ||
    EDITABLE_TAGS.includes((target.tagName ?? "").toUpperCase()));

const diffShortcutOf = (event: KeyLike): ReaderIntent | undefined => {
  if (event.shiftKey === true && (event.key === "D" || event.key === "d"))
    return { kind: "diffToggled" };
  // `w` 是 Revert（撤销上一 revision），不是"接受"——kind 名与语义必须一致。
  return event.key === "w" ? { kind: "revert" } : undefined;
};

const isPrintableShortcut = (event: KeyLike, state: ReaderState): ReaderIntent | undefined => {
  const diffIntent = diffShortcutOf(event);
  if (diffIntent !== undefined) return diffIntent;
  if (event.key === "/") return { kind: "searchOpened" };
  if (event.key === "j") return { kind: "move", delta: 1 };
  if (event.key === "k") return { kind: "move", delta: -1 };
  if (event.key === "h") return { kind: "toggleFocus" };
  if (event.key === "c")
    return state.activeId === undefined ? undefined : { kind: "openSidenote", id: state.activeId };
  return undefined;
};

/** 演示态键盘只认翻页/退出：其余键整片吞掉，`j`/`w` 这类读写键绝不能漏到阅读态。 */
const presentIntentOf = (event: KeyLike, state: ReaderState): ReaderIntent | undefined => {
  switch (event.key) {
    case "ArrowRight":
    case "ArrowDown":
    case " ":
    case "PageDown":
      return { kind: "presentAdvanced" };
    case "ArrowLeft":
    case "ArrowUp":
    case "PageUp":
      return { kind: "presentBack" };
    case "Home":
      return { kind: "presentMoved", page: 0 };
    case "End":
      return { kind: "presentMoved", page: state.pages.length - 1 };
    case "Escape":
    case "p":
    case "F5":
      return { kind: "presentExited" };
    default:
      return undefined;
  }
};

export const intentOf = (event: KeyLike, state: ReaderState): ReaderIntent | undefined => {
  if (modified(event) || isEditableTarget(event.target)) return undefined;
  if (state.present.active) return presentIntentOf(event, state);
  if (event.key === "Escape") return { kind: "panelClosed" };
  if (event.key === "p" || event.key === "F5") return { kind: "presentEntered" };
  return isPrintableShortcut(event, state);
};
