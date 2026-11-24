// 这层管：组装（store ← sse ← widgets ← keys ← style）。没有业务规则：
// 状态迁移在 `state.ts`，渲染在 `widgets/**`，state → DOM 的全量同步在 `wiring.ts` 的 `syncView`，
// 退避在 `sse.ts`；这里只做"接线 + 串行泵"。

import type { Host } from "./dom.ts";
import { intentOf, type KeyLike } from "./keys.ts";
import type { Sse, SseEvent, SseHandlers } from "./sse.ts";
import type { ConnState, OutlineNode, ReaderIntent, ReaderState } from "./state.ts";
import type { Store } from "./store.ts";
import type { StyleSwitch } from "./style-switch.ts";
import { changedNodesOf, flashChanged, type Schedule } from "./flash.ts";
import { mountCanvas } from "./widgets/canvas.ts";
import type { Widget } from "./widgets/library.ts";
import { mountLibrary } from "./widgets/library.ts";
import { mountSidenotes } from "./widgets/sidenotes.ts";
import { mountStatusbar } from "./widgets/statusbar.ts";
import { renderNotes, wireNotes, type NotesDeps } from "./notes-wire.ts";
import { missingAnchorsOf, reportMissingAnchors } from "./anchors.ts";
import type { RawSelection } from "./widgets/selection.ts";
import { COPY } from "./widgets/copy.ts";
import { mountPresent, type PresentShell, type PresentWidget } from "./widgets/present.ts";
import { syncView } from "./wiring.ts";

export interface ModelResponse {
  readonly revision: string;
  readonly model: {
    readonly children?: readonly { readonly id?: string; readonly tag?: string }[];
  };
}

export interface OutlineResponse {
  readonly outline: { readonly nodes: readonly OutlineNode[] };
}

export interface BootDeps {
  readonly host: Host;
  readonly store: Store;
  /** 由 boot 传入 handler 后返回连接对象（`main.ts` 负责把真 `EventSource` 塞进去）。 */
  readonly openSse: (handlers: SseHandlers) => Sse;
  /** 闪烁的计时器；缺省用真 `setTimeout`（`main.ts` 不传即真实现）。 */
  readonly schedule?: Schedule;
  readonly style: StyleSwitch;
  /** 文档正文 HTML（`GET /s/<docId>`）。 */
  readonly documentHtml: string;
  /** 服务器给的清单与默认名：客户端不硬编码主题名。 */
  readonly themes: readonly string[];
  /** 服务器给的默认名；缺省取清单第一项（测试可省略，源码里没有魔法字符串）。 */
  readonly defaultTheme?: string;
  readonly fetchDocument: () => Promise<string>;
  readonly fetchModel: () => Promise<ModelResponse>;
  readonly fetchOutline: () => Promise<OutlineResponse>;
  /** 键盘事件源（真实实现是 `window`，由 `main.ts` 注入）。 */
  readonly keySource: (handler: (event: KeyLike) => void) => () => void;
  /** 批注与 diff 的接线；缺省时批注相关意图全部无副作用。 */
  readonly notes?: NotesDeps;
  /** 演示模式的浏览器环境（全屏 / hash）；缺省 = 这两项副作用退化为 no-op。 */
  readonly present?: PresentShell;
  /** 诊断出口（缺锚点等"必须可见地失败"的消息）；`main.ts` 接 `console.error`。 */
  readonly logger?: (message: string) => void;
}

export interface Booted {
  readonly destroy: () => void;
  /** 选区事件入口（`main.ts` 在 `mouseup` 时调；跨块/空白选区不产生意图）。 */
  readonly selection?: (selection: RawSelection) => void;
}

const ROOT = "#hr-root";

const blocksOfModel = (model: ModelResponse): readonly string[] =>
  (model.model.children ?? []).flatMap((node) => (node.id === undefined ? [] : [node.id]));

/**
 * 演示页 = 顶层 `h1`（封面）+ 顶层 `section`（一页一节），保持文档序。
 * 一节都没有时退化为全部顶层块——外来文档没有 section，逐块分页仍讲得完。
 */
const pagesOfModel = (model: ModelResponse): readonly string[] => {
  const children = model.model.children ?? [];
  const hasSection = children.some((node) => node.tag === "section");
  if (!hasSection) return blocksOfModel(model);
  return children.flatMap((node) =>
    node.id !== undefined && (node.tag === "h1" || node.tag === "section") ? [node.id] : [],
  );
};

/** 一次只跑一个刷新，后到的排队（同一个文档的 patch 会连发多条事件）。 */
const createPump = (): ((task: () => Promise<void>) => void) => {
  let tail: Promise<void> = Promise.resolve();
  return (task) => {
    tail = tail.then(task, task);
  };
};

interface Mounted {
  readonly widgets: readonly Widget[];
  /** 演示 widget 单独拎出来：`before` 要在 dispatch 前拦 `presentAdvanced`（放步进不翻页）。 */
  readonly present: PresentWidget;
}

const mountAll = (deps: BootDeps, forward: (intent: ReaderIntent) => void): Mounted => {
  const state = deps.store.get();
  const present = mountPresent({
    host: deps.host,
    parent: ROOT,
    shell: deps.present ?? {},
    onIntent: forward,
  });
  return {
    widgets: [
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
      present,
    ],
    present,
  };
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
const themeSwitcher =
  (deps: BootDeps, pump: (task: () => Promise<void>) => void) =>
  (intent: Extract<ReaderIntent, { kind: "themeSelected" }>): void => {
    pump(async () => {
      await settleTheme(deps, { theme: intent.theme, previous: deps.store.get().theme });
    });
  };

const dispatchLoaded = (
  store: Store,
  model: ModelResponse,
  outline: OutlineResponse,
  html: string,
): readonly string[] => {
  const blocks = blocksOfModel(model);
  store.dispatch({
    kind: "blocksLoaded",
    blocks,
    outline: outline.outline.nodes,
    revision: model.revision,
    html,
    pages: pagesOfModel(model),
  });
  return blocks;
};

const reloadOf =
  (deps: BootDeps, store: Store, refresh: () => Promise<void>) => async (): Promise<void> => {
    const [model, outline, html] = await Promise.all([
      deps.fetchModel(),
      deps.fetchOutline(),
      deps.fetchDocument(),
    ]);
    const blocks = dispatchLoaded(store, model, outline, html);
    store.dispatch({
      kind: "documentChanged",
      revision: model.revision,
      blocks,
      changedNodes: [],
      html,
    });
    await refresh();
  };

const hydrateOf = (deps: BootDeps, store: Store) => async (): Promise<void> => {
  const [model, outline] = await Promise.all([deps.fetchModel(), deps.fetchOutline()]);
  dispatchLoaded(store, model, outline, deps.documentHtml);
};

const keyHandlerOf =
  (store: Store, dispatchIntent: (intent: ReaderIntent) => void) =>
  (raw: KeyLike): void => {
    const intent = intentOf(raw, store.get());
    if (intent === undefined) return;
    // 事件已消费就要拦默认行为：空格/方向键会滚动、F5 会刷新、`/` 会触发快速查找。
    raw.preventDefault?.();
    dispatchIntent(intent);
  };

const applyFirstTheme = (deps: BootDeps, pump: (task: () => Promise<void>) => void): void => {
  const first = deps.defaultTheme ?? deps.themes[0];
  if (first === undefined) return;
  pump(async () => {
    await settleTheme(deps, { theme: first, previous: first });
  });
};

const defaultSchedule: Schedule = (ms, run) => {
  const handle = setTimeout(run, ms);
  return () => {
    clearTimeout(handle);
  };
};

const sseHandlersOf = (
  deps: BootDeps,
  store: Store,
  pump: (task: () => Promise<void>) => void,
  hooks: { readonly reload: () => Promise<void>; readonly flash: { stop?: () => void } },
): SseHandlers => ({
  onEvent: (event: SseEvent): void => {
    if (event.type !== "doc.changed" && event.type !== "doc.reloaded") return;
    // 上一次闪烁的计时器先收掉：连发 `doc.changed` 时不留下孤儿定时器（也因此 `clearTimeout` 可达）。
    hooks.flash.stop?.();
    hooks.flash.stop = flashChanged(
      deps.host,
      changedNodesOf(event.payload),
      deps.schedule ?? defaultSchedule,
    );
    pump(hooks.reload);
  },
  onState: (conn: ConnState): void => {
    store.dispatch({ kind: "conn", conn });
  },
});

const bootedOf = (wired: ReturnType<typeof wireNotes> | undefined, stop: () => void): Booted => ({
  ...(wired === undefined
    ? {}
    : {
        selection: (raw: RawSelection): void => {
          wired.selection(raw);
        },
      }),
  destroy: stop,
});

interface FlowScope {
  readonly deps: BootDeps;
  readonly store: Store;
  readonly pump: (task: () => Promise<void>) => void;
  readonly dispatch: (intent: ReaderIntent) => void;
  readonly reload: () => Promise<void>;
}

const wiredOf = (scope: FlowScope): ReturnType<typeof wireNotes> | undefined => {
  const { deps, store, pump, dispatch, reload } = scope;
  if (deps.notes === undefined) return undefined;
  const wired = wireNotes({ host: deps.host, notes: deps.notes, reload, store, pump, dispatch });
  wired.wireDom();
  return wired;
};

/** 首屏记账 + 主题 + 目录与模型水合 + SSE + 键盘：返回拆卸函数（`boot` 只保留调度与装配）。 */
const startFlows = (scope: FlowScope): (() => void) => {
  const { deps, store, pump, dispatch, reload } = scope;
  store.dispatch({
    kind: "blocksLoaded",
    blocks: store.get().blocks,
    outline: store.get().outline,
    html: deps.documentHtml,
  });
  applyFirstTheme(deps, pump);
  pump(hydrateOf(deps, store));
  const flash: { stop?: () => void } = {};
  const sse = deps.openSse(sseHandlersOf(deps, store, pump, { reload, flash }));
  const unbindKeys = deps.keySource(keyHandlerOf(store, dispatch));
  sse.start();
  return () => {
    flash.stop?.();
    unbindKeys();
    sse.close();
    deps.host.destroy();
  };
};

const subscribeOf = (deps: BootDeps, widgets: readonly Widget[]): (() => void) =>
  deps.store.subscribe(
    syncView({
      host: deps.host,
      widgets,
      ...(deps.notes === undefined
        ? {}
        : {
            renderNotes: (state: ReaderState) => {
              renderNotes(deps.host, state);
            },
          }),
    }),
  );

export const boot = (deps: BootDeps): Booted => {
  const { host, store } = deps;
  const pump = createPump();
  const selectTheme = themeSwitcher(deps, pump);
  const wiredRef: { current: ReturnType<typeof wireNotes> | undefined } = { current: undefined };
  const presentRef: { current: PresentWidget | undefined } = { current: undefined };
  function dispatchIntent(intent: ReaderIntent): void {
    // 守卫必须在 dispatch **之前**求值：`w` 的可用性取决于"此刻"面板是否开着，
    // `presentAdvanced` 要不要翻页取决于"此刻"页内还有没有没放出的步进。
    if (wiredRef.current !== undefined && !wiredRef.current.before(intent)) return;
    if (presentRef.current !== undefined && !presentRef.current.before(intent)) return;
    store.dispatch(intent);
    if (intent.kind === "themeSelected") selectTheme(intent);
    // `/` 只给可见提示：搜索框模板里是 `disabled`（不聚焦死控件）；同一句文案也写在它的 `title` 上。
    if (intent.kind === "searchOpened") host.text(`${ROOT} #hr-hint`, COPY.searchDeferred);
    wiredRef.current?.after(intent);
  }
  const reload = reloadOf(deps, store, async () => {
    await wiredRef.current?.load();
  });
  const scope: FlowScope = { deps, store, pump, dispatch: dispatchIntent, reload };
  const mounted = mountAll(deps, dispatchIntent);
  presentRef.current = mounted.present;
  const wired = wiredOf(scope);
  wiredRef.current = wired;
  host.attr(`${ROOT} #hr-search`, "title", COPY.searchDeferred);
  if (host.has !== undefined) {
    reportMissingAnchors(host, deps.logger ?? (() => undefined), missingAnchorsOf(host));
  }
  const unsubscribe = subscribeOf(deps, mounted.widgets);
  if (wired !== undefined) pump(wired.load);
  const stopFlows = startFlows(scope);
  return bootedOf(wired, () => {
    unsubscribe();
    stopFlows();
  });
};
