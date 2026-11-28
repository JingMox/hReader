// webview/*.js 的测试沙盒：脚本是 sourceType=script（非模块），靠 window.__hrd 共享
// 注册表互相装配。这里用 happy-dom 窗口 + node:vm 复刻 src-tauri/src/workbench/script.rs
// 的装载语义：每个文件包一层 `{}` 作用域，按 WORKBENCH_JS_MODULES 的顺序跑。

import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { Window } from "happy-dom";
import type { Document, Element, KeyboardEvent } from "happy-dom";
import { vi } from "vitest";
import type { Mock } from "vitest";

const WEBVIEW_DIR = fileURLToPath(new URL("../webview/", import.meta.url));

/** 与 `src-tauri/src/workbench/script.rs` 的 WORKBENCH_JS_MODULES 严格同序。 */
export const WORKBENCH_MODULES = [
  "state.js",
  "components.js",
  "theme.js",
  "tree.js",
  "editor-dom.js",
  "editor-ops.js",
  "source-view.js",
  "overlay.js",
  "modals.js",
  "sidebar.js",
  "statusbar.js",
  "immersive.js",
  "menu-shortcuts.js",
] as const;

export interface CustomTheme {
  id: string;
  name: string;
  base: string;
  vars: Record<string, string>;
  css: string;
}

export interface DocError {
  docId: string;
  message: string;
}

export interface DesktopContext {
  workspace: string;
  docId: string;
  files: string[];
  tree: TreeNode[];
  customThemes: CustomTheme[];
  isMacos: boolean;
  docError?: DocError | null;
  /** Default document-template id from shell settings; `null` = blank. */
  defaultTemplate?: string | null;
  bridgeToken: string;
}

export interface TreeNode {
  name: string;
  path: string;
  kind: "file" | "dir" | "page-folder";
  children?: TreeNode[];
  assets?: TreeNode[];
  title?: string;
  entry?: string;
  hidden?: boolean;
}

export interface Prefs {
  uiTheme?: string;
  bottomBarStyle?: string;
  fontSize?: number;
  lineHeight?: number;
  maxWidth?: string;
  showBlockIds?: boolean;
  focusMode?: boolean;
  defaultVisual?: string;
  showAllFiles?: boolean;
  [key: string]: unknown;
}

export interface HrdState {
  prefs: Prefs;
  ctx: DesktopContext;
  activeSidebarTab: string;
  searchOpen: boolean;
  sourceMode: boolean;
  notesOpen: boolean;
  activeEditId: string | null;
  editDirty: boolean;
  saveTimer: ReturnType<typeof setTimeout> | null;
  saveInFlight: Promise<unknown>;
  openMenuKind: string | null;
  expandedDirs: Set<string>;
  lastAutoExpandedDoc: string;
  templates: {
    status: "idle" | "loading" | "ready" | "error";
    list: { id: string; name?: string; source: string; format?: string; description?: string }[];
    diagnostics: { id: string; source: string; message: string }[];
    error: string;
  };
  [key: string]: unknown;
}

export interface Hrd {
  css: string;
  state: HrdState;
  COMPONENTS?: { id: string; label: string; tag: string; html: string }[];
  ICONS?: Record<string, string>;
  DEFAULT_PREFS?: Prefs;
  readStorage: (storage: unknown, key: string) => string | null;
  writeStorage: (storage: unknown, key: string, value: string) => boolean;
  removeStorage: (storage: unknown, key: string) => boolean;
  savePrefs: (next: Prefs) => Prefs;
  currentDocId: () => string;
  isEmptyMode: () => boolean;
  escapeHtmlText: (str: unknown) => string;
  workspaceBaseName: () => string;
  customThemesList: () => CustomTheme[];
  showToast: (msg: unknown, isError?: boolean) => void;
  setSaveState: (text: string) => void;
  apiPost: (url: string, payload?: unknown) => Promise<unknown>;
  bridgeNavigate: (path: string) => void;
  requestTemplates: () => void;
  applyTemplateResult: (payload: unknown) => void;
  renderTemplateUi: () => void;
  injectStyles: () => void;
  applyPrefs: () => void;
  ensureDefaultThemeLoaded: () => void;
  buildUiThemeOptionsHtml: () => string;
  saveExpandedDirs: (set: Set<string>) => void;
  renderFilesPanel: (filter: string) => void;
  filterToc: (filter: string) => void;
  isSimpleEditableBlock: (el: unknown) => boolean;
  contentBlocks: () => Element[];
  closestTopBlock: (node: unknown) => Element | null;
  activeBlockEl: () => Element | null;
  cleanBlockClone: (el: Element) => Element;
  serializeBlockHtml: (el: Element, tagOverride?: string) => string;
  enableBlockEditable: (el: Element) => void;
  syncAllEditables: () => void;
  focusBlockById: (
    id: string,
    atEnd?: boolean,
    attemptsLeft?: number,
    expectedTag?: string,
  ) => void;
  patchNode: (targetId: string, action: string, fragment?: string) => Promise<unknown>;
  flushBlockSave: (el: Element | null, tagOverride?: string) => Promise<unknown>;
  convertBlockTag: (el: Element | null, tag: string) => Promise<void>;
  tryMarkdownPrefix: (el: Element) => boolean;
  insertAfterBlock: (
    el: Element | null,
    fragment: string,
    label: string | null,
    focusNew: boolean,
  ) => Promise<unknown>;
  deleteBlock: (el: Element | null) => Promise<void>;
  undoDocument: () => Promise<void>;
  persistStyle: (visualId: string) => Promise<void>;
  toggleSourceMode: () => void;
  renderSourcePane: () => void;
  ensureOverlayTitlebar: () => void;
  buildSidebarEnhancements: () => void;
  buildNotesDrawerChrome: () => void;
  openNotesDrawer: (open?: boolean) => void;
  toggleLeftSidebar: (force?: boolean) => void;
  toggleSearchBox: (force?: boolean) => void;
  openLibrarySearch: () => void;
  renderSidebarHeader: () => void;
  setSidebarMode: (mode: string) => void;
  renderEmptyState: () => void;
  updateDocBadge: () => void;
  ensureFallbackDragStrip: () => void;
  runExportAction: (kind: string) => void;
  showStatusbar: () => void;
  scheduleHideStatusbar: () => void;
  buildStatusbarEnhancements: () => void;
  openFloatMenu: (id: string, anchor: unknown, html: string, onPick: (a: string) => void) => void;
  closeFloatMenu: () => void;
  openFileSwitcherModal: () => void;
  openNewDocModal: () => void;
  openSaveAsTemplateModal: () => void;
  openSettingsModal: () => void;
  openHelpModal: () => void;
  wireImmersiveSync: () => void;
  toggleImmersive: () => void;
  openBlockHtmlModal: (el: Element | null) => void;
  openComponentModal: () => void;
  enhanceAnnotationCards: () => void;
  renderStats: () => void;
  updateSelectionPopover: () => void;
  ensureGutter: () => void;
  ensureSelectionPopover: () => void;
  positionGutter: (el: Element) => void;
  hideGutter: () => void;
  [key: string]: unknown;
}

export type HrdWindow = Window & {
  __hrd?: Record<string, unknown>;
  __HR_DESKTOP_CTX__?: DesktopContext;
  __hrMenuAction?: (action: string) => void;
  __hrDesktopSync?: (ctx: DesktopContext) => void;
  __hrDesktopToast?: (msg: string, isErr: boolean) => void;
  __hrTemplateResult?: (payload: unknown) => void;
  __hrDefaultTemplate?: (id: string | null) => void;
};

export interface Sandbox {
  window: HrdWindow;
  document: Document;
  hrd: Hrd;
  ctx: DesktopContext;
  /** happy-dom 没有 window.print——这是挂上去的间谍，断言行数用它。 */
  print: Mock;
  /** 释放 happy-dom 的定时器与挂起任务，防测试句柄泄漏。 */
  dispose(): void;
}

/** daemon 下发的最小工作台骨架：bootstrap.js 见到 #hr-root 才会完成一轮装配。 */
export const WORKBENCH_HTML = `
  <div id="hr-root">
    <div id="hr-library">
      <input id="hr-search" type="search" />
      <ol id="hr-toc"></ol>
    </div>
    <div id="hr-canvas">
      <div id="hr-doc"><article data-hr-id="doc"><p data-hr-id="b1">正文</p></article></div>
      <div id="hr-notes"></div>
    </div>
    <div id="hr-statusbar">
      <span id="hr-conn"></span>
      <span id="hr-perms">
        <button id="hr-perm-scripts" type="button"></button>
        <button id="hr-perm-network" type="button"></button>
      </span>
      <button id="hr-immersive-btn" type="button"></button>
      <span id="hr-hint"></span>
    </div>
    <style id="hr-theme"></style>
    <select id="hr-theme-select"></select>
  </div>
`;

export function defaultCtx(overrides: Partial<DesktopContext> = {}): DesktopContext {
  return {
    workspace: "/tmp/ws",
    docId: "doc.html",
    files: ["doc.html"],
    tree: [],
    customThemes: [],
    isMacos: true,
    docError: null,
    bridgeToken: "test-token",
    ...overrides,
  };
}

export function loadModules(win: HrdWindow, modules: readonly string[]): void {
  for (const name of modules) {
    const source = readFileSync(WEBVIEW_DIR + name, "utf8");
    vm.runInContext(`{\n${source}\n}`, win, {
      filename: `webview/${name}`,
    });
  }
}

/**
 * 建一个注入工作台脚本的 happy-dom 沙盒。
 * `html` 填进 document.body——没给 hr-root 时 bootstrap.js 会按生产逻辑反复重试。
 */
export function createSandbox(
  options: {
    ctx?: Partial<DesktopContext>;
    html?: string;
    url?: string;
    modules?: readonly string[];
    bootstrap?: boolean;
    /** 模块求值前执行：写 localStorage / 改 location 这类"先于脚本存在"的状态走这里。 */
    beforeLoad?: (win: HrdWindow) => void;
  } = {},
): Sandbox {
  const win = new Window({
    url: options.url ?? "http://127.0.0.1:8123/",
  }) as HrdWindow;
  const ctx = defaultCtx(options.ctx);
  win.__hrd = { css: "" };
  win.__HR_DESKTOP_CTX__ = ctx;
  options.beforeLoad?.(win);
  // happy-dom 没有 window.print；产品语义里它调用系统打印对话框，测试只断言被触发。
  const print = vi.fn();
  // happy-dom 的 fetch 走真实网络：默认换成空响应 stub，测试按需覆盖。
  const fetchStub = vi.fn(() => Promise.resolve(new win.Response("{}", { status: 200 })));
  Object.assign(win, { print, fetch: fetchStub });
  win.document.body.innerHTML = options.html ?? WORKBENCH_HTML;
  vm.createContext(win);
  const modules = [...(options.modules ?? WORKBENCH_MODULES)];
  if (options.bootstrap !== false) modules.push("bootstrap.js");
  loadModules(win, modules);
  const hrd = win.__hrd as unknown as Hrd;
  return {
    window: win,
    document: win.document,
    hrd,
    ctx,
    print,
    dispose() {
      void win.happyDOM.abort();
      void win.happyDOM.close();
    },
  };
}

export function keydown(
  win: Window,
  init: {
    key: string;
    metaKey?: boolean;
    ctrlKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
  },
): KeyboardEvent {
  const event = new win.KeyboardEvent("keydown", {
    key: init.key,
    metaKey: Boolean(init.metaKey),
    ctrlKey: Boolean(init.ctrlKey),
    shiftKey: Boolean(init.shiftKey),
    altKey: Boolean(init.altKey),
    bubbles: true,
    cancelable: true,
  });
  win.dispatchEvent(event);
  return event;
}

export function mustGet(doc: Document, selector: string): Element {
  const el = doc.querySelector(selector);
  if (!el) throw new Error(`sandbox DOM 里缺 ${selector}`);
  return el;
}
