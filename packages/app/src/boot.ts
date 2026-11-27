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
import type { AnnotateEnv, AnnotateIo } from "./widgets/annotate.ts";
import {
  mountForeign,
  type DocGate,
  type DocPermissions,
  type ForeignHandle,
  type ForeignInput,
  type PermissionPatch,
  type TrustLevel,
} from "./widgets/foreign.ts";
import { syncView } from "./wiring.ts";

// doc-gate 桥推送要走 window（桌面壳注入的 __HR_DESKTOP_CTX__ + location.assign 投递）。
declare const window: {
  readonly __HR_DESKTOP_CTX__?: { readonly bridgeToken?: string };
  readonly location: { assign(url: string): void };
};

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

/** `GET /api/doc/<id>/info`：启动分流唯一依据；`trust`/`scripts`/`permissions` 只对外来文档有意义。 */
export interface DocInfo {
  readonly revision: string;
  readonly cls: "managed" | "normalizable" | "foreign";
  readonly reason?: string;
  readonly kind?: string;
  readonly trust?: TrustLevel;
  readonly scripts?: boolean;
  /** 外来文档的生效权限视图（脚本/联网 + 来源 + 全局模式）；managed/normalizable 无此字段。 */
  readonly permissions?: DocPermissions;
  /** `/f/<cap>/<file>` iframe entry minted by the server; absent on older servers. */
  readonly frameUrl?: string;
}

/** managed 路径才需要的页面数据（主题清单 + 正文 HTML）；iframe 路径不拉正文。 */
export interface ManagedPage {
  readonly themes: readonly string[];
  readonly defaultTheme?: string;
  readonly documentHtml: string;
}

export interface ClassifiedBootDeps extends Omit<
  BootDeps,
  "documentHtml" | "themes" | "defaultTheme"
> {
  /** `GET /api/doc/<id>/info`：先分档再决定走 `boot` 还是 iframe 路径。 */
  readonly fetchInfo: () => Promise<DocInfo>;
  /** managed 分支的数据源：foreign/normalizable 首屏不调它（iframe 自己加载 `/s/`）。 */
  readonly fetchPage: () => Promise<ManagedPage>;
  /** `POST /api/doc/:docId/permissions`；resolve 的值为服务端确认的生效视图。 */
  readonly postPermissions: (patch: PermissionPatch) => Promise<DocPermissions>;
  /** `POST /normalize`；响应体不读——成功后靠 `bootDocument` 重取 info 分流。 */
  readonly postNormalize: () => Promise<unknown>;
  /** `GET /api/theme`：外来壳的主题下拉也要清单（managed 从 `fetchPage` 一起拿）。 */
  readonly fetchThemes: () => Promise<{
    readonly themes: readonly string[];
    readonly default: string;
  }>;
  /** `POST /api/style {docId, visualId}`：外来文档的主题写进文件里的 `<style id="hr-theme">`。 */
  readonly postStyle: (visualId: string) => Promise<unknown>;
  /** 批注模式的 IO + 消息环境；缺省 = 批注钮不出现（测试/老壳）。 */
  readonly annotate?: { readonly io: AnnotateIo; readonly env: AnnotateEnv } | undefined;
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
      mountStatusbar(deps.host, ROOT, forward),
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
): SseHandlers => {
  // 连发 doc.changed 合并：reload 是"全量重取"，排队未跑的那一个一定会取到
  // 最新状态——事件落在已排队段就不再叠泵；落在执行段则新排一个（其变更晚于在途取数）。
  // 不合并的话，一串补丁在泵上积成多次全量重取，高负载下末次刷新会拖过等待时限。
  let reloadQueued = false;
  return {
    onEvent: (event: SseEvent): void => {
      if (event.type !== "doc.changed" && event.type !== "doc.reloaded") return;
      // 上一次闪烁的计时器先收掉：连发 `doc.changed` 时不留下孤儿定时器（也因此 `clearTimeout` 可达）。
      hooks.flash.stop?.();
      hooks.flash.stop = flashChanged(
        deps.host,
        changedNodesOf(event.payload),
        deps.schedule ?? defaultSchedule,
      );
      if (reloadQueued) return;
      reloadQueued = true;
      pump(async () => {
        reloadQueued = false;
        await hooks.reload();
      });
    },
    onState: (conn: ConnState): void => {
      store.dispatch({ kind: "conn", conn });
    },
  };
};

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

const foreignSseOf = (store: Store, foreign: ForeignHandle, resync: () => void): SseHandlers => ({
  onEvent: (event: SseEvent): void => {
    // 全局权限模式变更影响所有打开的外来文档：回拉 info 让 syncInfo 决定要不要重载 iframe。
    if (event.type === "permissions.changed") {
      resync();
      return;
    }
    // 旁注写路径（含本端保存）广播 doc.annotations：非本 doc 的事件直接丢。
    if (event.type === "doc.annotations") {
      if (event.payload["docId"] === store.get().docId) foreign.annotationsChanged();
      return;
    }
    if (event.type !== "doc.changed" && event.type !== "doc.reloaded") return;
    const revision = event.payload["revision"];
    foreign.refresh(typeof revision === "string" ? revision : undefined);
    // 写盘/换 sha 之后服务端的权限/cls 都可能变：异步回拉 info 对账，不只换 src。
    resync();
  },
  onState: (conn: ConnState): void => {
    store.dispatch({ kind: "conn", conn });
  },
});

/**
 * 把外来壳的导航门栏状态推给桌面壳：经 `hr-desktop.local/doc-state` 桥导航投递
 * （壳在 on_navigation 里拦截、永不真正导航）。桥令牌只存在于桌面壳注入的
 * `__HR_DESKTOP_CTX__`；浏览器里没有它，整段调用直接早退。
 */
const reportDocGate = (gate: DocGate): void => {
  // 浏览器外（单测）没有 window：桌面上下文必缺席，与无令牌同一条早退路。
  if (typeof window === "undefined") return;
  const token = (window as { __HR_DESKTOP_CTX__?: { bridgeToken?: string } }).__HR_DESKTOP_CTX__
    ?.bridgeToken;
  if (typeof token !== "string" || token === "") return;
  const query = `doc=${encodeURIComponent(gate.docId)}&foreign=${gate.foreign ? "1" : "0"}&net=${
    gate.network ? "1" : "0"
  }&t=${encodeURIComponent(token)}`;
  window.location.assign(`http://hr-desktop.local/doc-state?${query}`);
};

/**
 * 外来/未规范化路径：iframe + 横幅 + 主题下拉 + 状态栏是全部 UI——model 系功能（编辑、批注、
 * 大纲、演示、快捷键）不接线，而不是"接了再禁用"。`doc.changed` 重载 iframe 并回拉 info。
 */
const bootForeign = (
  deps: ClassifiedBootDeps,
  cls: ForeignInput["cls"],
  info: DocInfo,
  themes: { readonly themes: readonly string[]; readonly default: string },
): Booted => {
  const { host, store } = deps;
  const pump = createPump();
  let inner: Booted | undefined;
  let stopped = false;

  const foreign = mountForeign({
    host,
    parent: ROOT,
    docId: store.get().docId,
    info: {
      cls,
      scripts: info.scripts === true,
      ...(info.permissions === undefined ? {} : { permissions: info.permissions }),
      ...(info.frameUrl === undefined ? {} : { frameUrl: info.frameUrl }),
    },
    setPermissions: deps.postPermissions,
    normalize: async () => {
      await deps.postNormalize();
      await reboot();
    },
    theme:
      themes.themes.length === 0
        ? undefined
        : {
            themes: themes.themes,
            current: themes.default,
            apply: async (id) => {
              await deps.postStyle(id);
            },
          },
    reportGate: reportDocGate,
    annotate: deps.annotate,
  });
  // 外来壳也接键盘与沉浸开关：j/k 等块导航意图对空 blocks 自然空转，只有沉浸与连接态有出口。
  const dispatchIntent = (intent: ReaderIntent): void => {
    store.dispatch(intent);
  };
  const statusbar = mountStatusbar(host, ROOT, dispatchIntent);
  host.text(`${ROOT} #hr-shortcuts`, COPY.foreignShortcuts);
  const unbindKeys = deps.keySource(keyHandlerOf(store, dispatchIntent));
  const unsubscribe = deps.store.subscribe(syncView({ host, widgets: [statusbar] }));
  const sse = deps.openSse(
    foreignSseOf(store, foreign, () => {
      pump(async () => {
        const next = await deps.fetchInfo();
        if (stopped) return;
        // 外部把文档写成了托管形态：整壳重进分流，和 normalize 一条路径。
        if (next.cls === "managed") {
          await reboot();
          return;
        }
        foreign.syncInfo({
          cls: next.cls,
          scripts: next.scripts === true,
          ...(next.permissions === undefined ? {} : { permissions: next.permissions }),
          ...(next.frameUrl === undefined ? {} : { frameUrl: next.frameUrl }),
        });
      });
    }),
  );
  sse.start();

  // 重走完整分流而不是就地拼 managed：normalize 或 cls 重分档后 info/主题/正文全部要重取。
  // 至多跑一次：destroy 置 stopped 后续跑走早退，成功后 destroy 转给 inner。
  async function reboot(): Promise<void> {
    const next = await bootDocument(deps);
    if (stopped) {
      next.destroy();
      return;
    }
    teardown();
    inner = next;
  }

  // 点击回调只可能晚于装配完成，hoist 的函数声明让 normalize/reboot 能向前引用它。
  function teardown(): void {
    sse.close();
    unbindKeys();
    unsubscribe();
    foreign.destroy();
  }

  return {
    destroy: () => {
      if (stopped) return;
      stopped = true;
      if (inner === undefined) {
        teardown();
        return;
      }
      inner.destroy();
    },
  };
};

/** 启动分流：先 `info` 分档——managed 原样走 `boot`；normalizable/foreign 走 iframe 壳。 */
export const bootDocument = async (deps: ClassifiedBootDeps): Promise<Booted> => {
  const info = await deps.fetchInfo();
  if (info.cls === "managed") {
    const page = await deps.fetchPage();
    return boot({ ...deps, ...page });
  }
  const themes = await deps.fetchThemes();
  return bootForeign(deps, info.cls, info, themes);
};
