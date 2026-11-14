// 这层管：组装（store ← sse ← widgets ← keys ← style）。没有业务规则：
// 状态迁移在 `state.ts`，渲染在 `widgets/**`，退避在 `sse.ts`；这里只做"接线 + 串行泵"。

import type { Host } from "./dom.ts";
import { intentOf, type KeyLike } from "./keys.ts";
import type { Sse, SseEvent, SseHandlers } from "./sse.ts";
import type { ConnState, OutlineNode, ReaderIntent, ReaderState } from "./state.ts";
import type { Store } from "./store.ts";
import type { StyleSwitch } from "./style-switch.ts";
import { mountCanvas } from "./widgets/canvas.ts";
import type { Widget } from "./widgets/library.ts";
import { mountLibrary } from "./widgets/library.ts";
import { mountSidenotes } from "./widgets/sidenotes.ts";
import { mountStatusbar } from "./widgets/statusbar.ts";

export interface ModelResponse {
  readonly revision: string;
  readonly model: { readonly children?: readonly { readonly id?: string }[] };
}

export interface OutlineResponse {
  readonly outline: { readonly nodes: readonly OutlineNode[] };
}

export interface BootDeps {
  readonly host: Host;
  readonly store: Store;
  /** 由 boot 传入 handler 后返回连接对象（`main.ts` 负责把真 `EventSource` 塞进去）。 */
  readonly openSse: (handlers: SseHandlers) => Sse;
  readonly style: StyleSwitch;
  /** 文档正文 HTML（`GET /s/<docId>`）。 */
  readonly documentHtml: string;
  /** 服务器给的清单与默认名（裁定 #2：客户端不硬编码主题）。 */
  readonly themes: readonly string[];
  /** 服务器给的默认名；缺省取清单第一项（测试可省略，源码里没有魔法字符串）。 */
  readonly defaultTheme?: string;
  readonly fetchDocument: () => Promise<string>;
  readonly fetchModel: () => Promise<ModelResponse>;
  readonly fetchOutline: () => Promise<OutlineResponse>;
  /** 键盘事件源（真实实现是 `window`，由 `main.ts` 注入）。 */
  readonly keySource: (handler: (event: KeyLike) => void) => () => void;
}

export interface Booted {
  readonly destroy: () => void;
}

const ROOT = "#hr-root";

const blocksOfModel = (model: ModelResponse): readonly string[] =>
  (model.model.children ?? []).flatMap((node) => (node.id === undefined ? [] : [node.id]));

/** 一次只跑一个刷新，后到的排队（同一个文档的 patch 会连发多条事件）。 */
const createPump = (): ((task: () => Promise<void>) => void) => {
  let tail: Promise<void> = Promise.resolve();
  return (task) => {
    tail = tail.then(task, task);
  };
};

const mountAll = (deps: BootDeps, forward: (intent: ReaderIntent) => void): readonly Widget[] => {
  const state = deps.store.get();
  return [
    mountLibrary(deps.host, ROOT, state, forward),
    mountCanvas({
      host: deps.host,
      parent: ROOT,
      state,
      input: { html: deps.documentHtml, themes: deps.themes },
      onIntent: forward,
    }),
    mountSidenotes(deps.host, ROOT),
    mountStatusbar(deps.host, ROOT),
  ];
};

/** 主题选择落地的唯一出口（`@internal` 导出：测试可 `await settleTheme(...)`，不必黑盒等泵）。 */
export const settleTheme = async (
  deps: Pick<BootDeps, "store" | "style">,
  intent: { readonly theme: string; readonly previous: string },
): Promise<boolean> => {
  const outcome = await deps.style.select(intent.theme, intent.previous);
  const ok = outcome.status !== "failed";
  deps.store.dispatch({ kind: "themeSettled", theme: intent.theme, ok });
  return ok;
};

/** 主题选择走 IO（`GET /api/theme/<id>`），所以单独接一条泵上任务。 */
const themeSwitcher = (
  deps: BootDeps,
  pump: (task: () => Promise<void>) => void,
): ((intent: Extract<ReaderIntent, { kind: "themeSelected" }>) => void) => {
  return (intent) => {
    pump(async () => {
      await settleTheme(deps, { theme: intent.theme, previous: deps.store.get().theme });
    });
  };
};

const reloadOf = (deps: BootDeps, store: Store): (() => Promise<void>) => {
  return async () => {
    const [model, outline, html] = await Promise.all([
      deps.fetchModel(),
      deps.fetchOutline(),
      deps.fetchDocument(),
    ]);
    const blocks = blocksOfModel(model);
    store.dispatch({
      kind: "blocksLoaded",
      blocks,
      outline: outline.outline.nodes,
      revision: model.revision,
    });
    store.dispatch({
      kind: "documentChanged",
      revision: model.revision,
      blocks,
      changedNodes: [],
      html,
    });
  };
};

const keyHandlerOf = (
  store: Store,
  dispatchIntent: (intent: ReaderIntent) => void,
): ((raw: KeyLike) => void) => {
  return (raw) => {
    const intent = intentOf(raw, store.get());
    if (intent === undefined) return;
    dispatchIntent(intent);
  };
};

const applyFirstTheme = (deps: BootDeps, pump: (task: () => Promise<void>) => void): void => {
  const first = deps.defaultTheme ?? deps.themes[0];
  if (first === undefined) return;
  pump(async () => {
    await settleTheme(deps, { theme: first, previous: first });
  });
};

const sseHandlersOf = (
  store: Store,
  pump: (task: () => Promise<void>) => void,
  reload: () => Promise<void>,
): SseHandlers => ({
  onEvent: (event: SseEvent): void => {
    if (event.type === "doc.changed" || event.type === "doc.reloaded") pump(reload);
  },
  onState: (conn: ConnState): void => {
    store.dispatch({ kind: "conn", conn });
  },
});

export const boot = (deps: BootDeps): Booted => {
  const { host, store } = deps;
  // 先建泵与主题切换器，再挂 widget：所有意图（键盘、下拉、TOC 点击、搜索框）都从
  // 这一个 `dispatchIntent` 出去——**同一意图只有一个出口**（见 G3-R3 #1 / G3-R5）。
  const pump = createPump();
  const selectTheme = themeSwitcher(deps, pump);
  const dispatchIntent = (intent: ReaderIntent): void => {
    store.dispatch(intent);
    if (intent.kind === "themeSelected") selectTheme(intent);
    if (intent.kind === "searchOpened") host.focus(`${ROOT} #hr-search`);
  };
  const widgets = mountAll(deps, dispatchIntent);
  const unsubscribe = store.subscribe((next: ReaderState) => {
    for (const widget of widgets) widget.update(next);
  });
  // 首屏的正文由 mount 注入；把它的指纹记进 state，后续只 diff 变化的块。
  store.dispatch({
    kind: "blocksLoaded",
    blocks: store.get().blocks,
    outline: store.get().outline,
    html: deps.documentHtml,
  });

  const reload = reloadOf(deps, store);
  // 首屏就应用默认主题（AC5.1 的"初始"，之前只有切换）。
  applyFirstTheme(deps, pump);
  const sse = deps.openSse(sseHandlersOf(store, pump, reload));
  const unbindKeys = deps.keySource(keyHandlerOf(store, dispatchIntent));
  sse.start();

  return {
    destroy: () => {
      unbindKeys();
      unsubscribe();
      sse.close();
      host.destroy();
    },
  };
};
