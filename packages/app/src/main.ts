// 这层管：唯一的浏览器入口——把真 `document`/`fetch`/`EventSource`/`window` 塞进纯层。
// （`wiring.ts` 的 `keySourceOf` 为了同处拥有键盘事件源，也持有一份最小 `window` 声明。）

import {
  boot,
  bootDocument,
  type Booted,
  type DocInfo,
  type ModelResponse,
  type OutlineResponse,
} from "./boot.ts";
import type { AppIo } from "./io.ts";
export type { AppIo, RevisionResponse } from "./io.ts";
import { createDomHost, type DocumentLike, type Host } from "./dom.ts";
import { isAnnotationList, isDiffResponse, isSearchReply } from "./guard.ts";
import { rawSelectionOf, type BlockElementLike } from "./widgets/selection.ts";
import { textOfBlocks } from "./widgets/blocks-text.ts";
import { createSse, type SseHandlers, type SourceLike } from "./sse.ts";
import { measureSelection } from "./measure.ts";
import { errorLogger } from "./log.ts";
import { initialState } from "./state.ts";
import { keySourceOf } from "./wiring.ts";
export {
  annotationIntentOf,
  renderAnnotations,
  renderDiff,
  revertOf,
  submitAnnotationOf,
} from "./wiring.ts";
import { createStore, type Store } from "./store.ts";
import { createStyleSwitch } from "./style-switch.ts";
import type { PresentShell } from "./widgets/present.ts";
import type { AnnotateEnv } from "./widgets/annotate.ts";
import { sidecarListOf, type WireAnchor } from "./annotate-proto.ts";
import type { DocPermissions, PermissionMode, PermissionSource } from "./widgets/foreign.ts";

/** 浏览器全局的最小声明（本仓库 tsconfig 不带 DOM lib）：只写我们真正用到的成员。 */
declare const document: DocumentLike;
declare const window: {
  readonly location: {
    readonly href: string;
    readonly hash?: string;
    readonly pathname?: string;
    readonly search?: string;
    /** Doc navigation for a search hit (`/?doc=` or the desktop `/open` bridge); test shells may omit it. */
    readonly assign?: (url: string) => void;
  };
  /** Bridge context injected by the desktop shell: a `bridgeToken` proves we run inside it. */
  readonly __HR_DESKTOP_CTX__?: { readonly bridgeToken?: string };
  /** Stash for a cross-doc annotation hit (same-origin sessionStorage survives the page load); may be absent in private mode. */
  readonly sessionStorage?: {
    readonly getItem: (key: string) => string | null;
    readonly setItem: (key: string, value: string) => void;
    readonly removeItem: (key: string) => void;
  };
  /** `replaceState` 写 hash 不堆历史记录；缺省表示环境不支持（hash 退化为只读）。 */
  readonly history?: {
    readonly replaceState: (data: unknown, unused: string, url: string) => void;
  };
  /** 划词：只读 `anchorNode/anchorOffset/focusNode/focusOffset` 四项。 */
  readonly getSelection?: () => {
    readonly anchorNode: {
      readonly parentElement: { readonly closest: BlockElementLike["closest"] } | null;
    } | null;
    readonly anchorOffset: number;
    readonly focusNode: {
      readonly parentElement?: { readonly closest: BlockElementLike["closest"] } | null;
    } | null;
    readonly focusOffset: number;
    /** 有 Range 就用它量块内字符偏移；没有则退回 anchor/focus 偏移。 */
    readonly rangeCount?: number;
    readonly getRangeAt?: (index: number) => {
      readonly startContainer: unknown;
      readonly startOffset: number;
      readonly endContainer: unknown;
      readonly endOffset: number;
    };
  } | null;
  readonly innerWidth: number;
  readonly innerHeight: number;
  /** `never` params let every event listener signature assign in (message/mouseup/pagehide/keydown each carry their own event face). */
  readonly addEventListener: (type: string, listener: (event: never) => void) => void;
  readonly removeEventListener: (type: string, listener: (event: never) => void) => void;
};
declare const EventSource: new (
  url: string,
  init?: { withCredentials?: boolean },
) => BrowserEventSource;

interface BrowserEventSource {
  readonly addEventListener: (
    type: string,
    listener: (event: { readonly data: string; readonly lastEventId: string }) => void,
  ) => void;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  readonly close: () => void;
}

/** 主题清单（`GET /api/theme`）：服务器是唯一来源，客户端不硬编码名字。 */
export interface ThemeList {
  readonly themes: readonly string[];
  readonly default: string;
}

export interface MainOptions {
  readonly host?: Host;
  /** 文档 id 的读取面：`document.body[data-doc-id]` 与 `location.href` 都可注入。 */
  readonly docIdSource?: { readonly attr: string | null; readonly href: string };
  readonly io?: AppIo;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

/** `EventSource` → `SourceLike`：适配点集中在这里，其它模块只认 `SourceLike`。 */
const sourceOf = (url: string): SourceLike => {
  const source = new EventSource(url, { withCredentials: true });
  return {
    addEventListener: (type, listener) => {
      source.addEventListener(type, (event) => {
        listener({ data: event.data, lastEventId: event.lastEventId });
      });
    },
    setOpen: (listener) => {
      source.onopen = () => {
        listener();
      };
    },
    setError: (listener) => {
      source.onerror = () => {
        listener();
      };
    },
    close: () => {
      source.close();
    },
  };
};

const openSse = (handlers: SseHandlers) =>
  createSse(
    "/api/events",
    {
      open: sourceOf,
      schedule: (ms, run) => {
        const handle = setTimeout(run, ms);
        return () => {
          clearTimeout(handle);
        };
      },
      random: () => Math.random(),
    },
    handlers,
  );

/** 主题清单的形状守卫（`@internal`：可单测）。 */
export const isThemeList = (value: unknown): value is ThemeList => {
  if (!isRecord(value)) return false;
  const themes = value["themes"];
  const fallback = value["default"];
  return (
    Array.isArray(themes) &&
    themes.every((item) => typeof item === "string") &&
    typeof fallback === "string"
  );
};

/** 灌给 `io.json` 的失败点：形状不符直接抛（`@internal`，测试可直接调）。 */
export const assertThemeList = (value: unknown, path = "/api/theme"): value is ThemeList => {
  if (!isThemeList(value)) throw new Error(`${path} → 响应形状不符`);
  return true;
};

export const isModelResponse = (value: unknown): value is ModelResponse =>
  isRecord(value) && typeof value["revision"] === "string" && isRecord(value["model"]);

export const isOutlineResponse = (value: unknown): value is OutlineResponse =>
  isRecord(value) && isRecord(value["outline"]) && Array.isArray(value["outline"]["nodes"]);

const isDocClass = (value: unknown): value is DocInfo["cls"] =>
  value === "managed" || value === "normalizable" || value === "foreign";

const isPermissionMode = (value: unknown): value is PermissionMode =>
  value === "allow" || value === "deny" || value === "per-doc";

const isPermissionSource = (value: unknown): value is PermissionSource =>
  value === "doc" || value === "global";

/** `info.permissions` / `POST /permissions` 应答里嵌套的生效视图：形状不对时宁可启动失败也不猜。 */
export const isDocPermissions = (value: unknown): value is DocPermissions =>
  isRecord(value) &&
  typeof value["scripts"] === "boolean" &&
  typeof value["network"] === "boolean" &&
  isPermissionSource(value["scriptsSource"]) &&
  isPermissionSource(value["networkSource"]) &&
  isRecord(value["modes"]) &&
  isPermissionMode(value["modes"]["scripts"]) &&
  isPermissionMode(value["modes"]["network"]);

const isPermissionsReply = (value: unknown): value is { readonly permissions: DocPermissions } =>
  isRecord(value) && isDocPermissions(value["permissions"]);

/** `GET /api/doc/<id>/info`：启动分流的唯一依据；`permissions` 存在时必须形状完整。 */
export const isDocInfo = (value: unknown): value is DocInfo =>
  isRecord(value) &&
  typeof value["revision"] === "string" &&
  isDocClass(value["cls"]) &&
  (value["frameUrl"] === undefined || typeof value["frameUrl"] === "string") &&
  (value["permissions"] === undefined || isDocPermissions(value["permissions"]));

const isNormalizeResponse = (
  value: unknown,
): value is { readonly revision: string; readonly cls: DocInfo["cls"] } =>
  isRecord(value) && typeof value["revision"] === "string" && isDocClass(value["cls"]);

/** `POST /api/doc/<id>/annotate` → `{frameUrl}`: accepts only the `/f/` entry (the server's only exit), length-capped. */
const isAnnotateReply = (value: unknown): value is { readonly frameUrl: string } =>
  isRecord(value) &&
  typeof value["frameUrl"] === "string" &&
  value["frameUrl"].startsWith("/f/") &&
  value["frameUrl"].length <= 4096;

/** Write replies are used as a success signal only (the list is always re-fetched): any record qualifies. */
const isAnyRecord = (value: unknown): value is Readonly<Record<string, unknown>> => isRecord(value);

const isStyleResponse = (
  value: unknown,
): value is { readonly changed: boolean; readonly revision: string } =>
  isRecord(value) && typeof value["revision"] === "string" && typeof value["changed"] === "boolean";

/** 缺省的 `AppIo`：真 `fetch`（`@internal`：测试可换掉它，不必起服务器）。 */
export const createHttpIo = (): AppIo => ({
  text: async (path) => {
    const response = await fetch(path, { credentials: "same-origin" });
    if (!response.ok) throw new Error(`${path} → ${String(response.status)}`);
    return await response.text();
  },
  post: async (path, body, guard) => {
    const response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-hr-csrf": "1",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${path} → ${String(response.status)}`);
    const parsed: unknown = await response.json();
    if (!guard(parsed)) throw new Error(`${path} → 响应形状不符`);
    return parsed;
  },
  json: async (path, guard) => {
    const response = await fetch(path, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`${path} → ${String(response.status)}`);
    const body: unknown = await response.json();
    if (!guard(body)) throw new Error(`${path} → 响应形状不符`);
    return body;
  },
});

/** 组装 `boot` 的依赖；IO 全部走注入（`@internal`：测试用假 io 驱动每一条分支）。 */
export interface BootInput {
  readonly docId: string;
  readonly themes: ThemeList;
  readonly documentHtml: string;
  readonly io: AppIo;
  readonly host: Host;
  /** 演示模式的浏览器环境；缺省用真 `document`/`window`（`@internal`：测试注入替身）。 */
  readonly present?: PresentShell;
}

/** Fullscreen API 任一缺席就整体退化（演示模式铺满视口的 CSS 兜底一直在）。 */
const fullscreenOf = (): PresentShell["fullscreen"] => {
  if (
    document.documentElement?.requestFullscreen === undefined ||
    document.exitFullscreen === undefined
  ) {
    return undefined;
  }
  return {
    // 进全屏会被浏览器拒（无用户手势/权限），拒绝是正常路径，吞掉即可——版式兜底在 CSS。
    enter: () => {
      void document.documentElement?.requestFullscreen?.().catch(() => undefined);
    },
    exit: () => {
      void document.exitFullscreen?.().catch(() => undefined);
    },
  };
};

const hashOfWindow = (): PresentShell["hash"] => ({
  read: () => (window.location.hash ?? "").replace(/^#/, ""),
  write: (hash) => {
    const base = `${window.location.pathname ?? ""}${window.location.search ?? ""}`;
    window.history?.replaceState(null, "", hash === "" ? base : `${base}#${hash}`);
  },
});

/** 演示模式的环境面：全屏三段 + hash 读写（`@internal`：测试可直接换掉全局再调）。 */
export const presentShellOf = (): PresentShell => ({
  fullscreen: fullscreenOf(),
  isFullscreen: () =>
    document.fullscreenElement !== undefined && document.fullscreenElement !== null,
  onFullscreenChange: (handler) => {
    document.addEventListener?.("fullscreenchange", handler);
    return () => {
      document.removeEventListener?.("fullscreenchange", handler);
    };
  },
  hash: hashOfWindow(),
});

/** 块的纯文本（`c` 键的整块锚点、diff 的 after）；标签只在这里被剥一次。 */
const bindOf =
  (io: AppIo) =>
  <T>(path: string, guard: (value: unknown) => value is T): (() => Promise<T>) =>
  async () =>
    await io.json(path, guard);

/** Cross-page stash key for an annotation hit: `{doc, ann}` is written before navigation, read and cleared at the next boot. */
const SEARCH_FOCUS_KEY = "hr-search-focus";

const stashSearchFocus = (doc: string, ann: string): void => {
  try {
    window.sessionStorage?.setItem(SEARCH_FOCUS_KEY, JSON.stringify({ doc, ann }));
  } catch {
    // When storage is unavailable, degrade to "open the doc only" (the focus is lost, navigation is not).
  }
};

/** Take and consume the stash: always removed first (a stale stash must not survive into a later navigation); `ann` is returned only when `doc` matches. */
const takeSearchFocus = (docId: string): string | undefined => {
  try {
    const raw = window.sessionStorage?.getItem(SEARCH_FOCUS_KEY);
    if (raw === undefined || raw === null) return undefined;
    window.sessionStorage?.removeItem(SEARCH_FOCUS_KEY);
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) && parsed["doc"] === docId && typeof parsed["ann"] === "string"
      ? parsed["ann"]
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Doc navigation for a search hit: inside the desktop shell we go through the
 * `hr-desktop.local/open` bridge (the shell turns it into a controlled open in
 * on_navigation); in a plain browser it's `/?doc=`. `annotationId` only goes into
 * sessionStorage — never the URL: the `/open` bridge forwards just `doc`, extra
 * params/hashes would be lost.
 */
const navigateToDoc = (path: string, annotationId?: string): void => {
  if (annotationId !== undefined) stashSearchFocus(path, annotationId);
  const token = window.__HR_DESKTOP_CTX__?.bridgeToken;
  const doc = encodeURIComponent(path);
  if (typeof token === "string" && token !== "") {
    window.location.assign?.(
      `http://hr-desktop.local/open?doc=${doc}&t=${encodeURIComponent(token)}`,
    );
    return;
  }
  window.location.assign?.(`/?doc=${doc}`);
};

/** 两条 boot 路径共用的依赖装配（store 由调用方给：managed 与 iframe 的初始主题不同）。 */
const depsCoreOf = (core: {
  readonly docId: string;
  readonly io: AppIo;
  readonly host: Host;
  readonly present: PresentShell;
  readonly store: Store;
}) => {
  const { docId, io, host, present, store } = core;
  const encoded = encodeURIComponent(docId);
  const bind = bindOf(io);
  return {
    /** D61 search panel: `q` is passed through verbatim (the server bounds by code points); limit is fixed at the default 20. */
    search: {
      fetch: async (query: string) =>
        await io.json(`/api/search?q=${encodeURIComponent(query)}&limit=20`, isSearchReply),
      navigate: navigateToDoc,
    },
    focusAnnotation: takeSearchFocus(docId),
    host,
    store,
    openSse,
    style: createStyleSwitch({
      loadCss: (id) => io.text(`/api/theme/${encodeURIComponent(id)}`),
      applyCss: (css) => {
        host.text("#hr-theme", css);
      },
    }),
    fetchDocument: async () => await io.text(`/s/${encoded}`),
    fetchModel: bind(`/api/doc/${encoded}/model`, isModelResponse),
    fetchOutline: bind(`/api/doc/${encoded}/outline`, isOutlineResponse),
    keySource: keySourceOf,
    present,
    logger: errorLogger,
    notes: {
      io,
      fetchAnnotations: async () =>
        await io.json(`/api/doc/${encoded}/annotations`, isAnnotationList),
      // diff 由服务端算（复用 core 的 `diffText`），浏览器只渲染 chunk。
      fetchDiff: async (annotationId: string) =>
        await io.json(
          `/api/doc/${encoded}/notes/${encodeURIComponent(annotationId)}/diff`,
          isDiffResponse,
        ),
      textOf: textOfBlocks(host, () => store.get().documentHtml),
    },
  };
};

export const bootWith = (input: BootInput): ReturnType<typeof boot> => {
  const { docId, themes, documentHtml, io, host, present = presentShellOf() } = input;
  const store = createStore(initialState(docId, themes.default));
  return boot({
    ...depsCoreOf({ docId, io, host, present, store }),
    documentHtml,
    themes: themes.themes,
    defaultTheme: themes.default,
  });
};

export interface BootDocumentInput {
  readonly docId: string;
  readonly io: AppIo;
  readonly host: Host;
  readonly present?: PresentShell;
}

/** 写命令的唯一封装点：trust/normalize 与批注走同一条 cookie+csrf 通道（`io.post` 缺席即明确报错）。 */
const postJson = async <T>(
  io: AppIo,
  path: string,
  body: Readonly<Record<string, unknown>>,
  guard: (value: unknown) => value is T,
): Promise<T> => {
  if (io.post === undefined) throw new Error("当前 IO 未实现写请求（POST）");
  return await io.post(path, body, guard);
};

/**
 * 真正的入口：`/info` 先分档——managed 走 `boot`；normalizable/foreign 走 iframe 壳。
 * normalize 成功后由 `bootDocument` 递归重进 managed，那时才拉主题与正文。
 */
export const bootDocumentWith = async (input: BootDocumentInput): Promise<Booted> => {
  const { docId, io, host, present = presentShellOf() } = input;
  const encoded = encodeURIComponent(docId);
  const bind = bindOf(io);
  // iframe 路径没有主题选择器：主题名先空着，managed（含 normalize 后重进）由 fetchPage 落到 store。
  const store = createStore(initialState(docId, ""));
  return await bootDocument({
    ...depsCoreOf({ docId, io, host, present, store }),
    fetchInfo: bind(`/api/doc/${encoded}/info`, isDocInfo),
    fetchPage: async () => {
      const [themes, documentHtml] = await Promise.all([
        io.json("/api/theme", assertThemeList),
        io.text(`/s/${encoded}`),
      ]);
      return { themes: themes.themes, defaultTheme: themes.default, documentHtml };
    },
    postPermissions: async (patch) => {
      const body: Record<string, unknown> = {};
      if (patch.scripts !== undefined) body["scripts"] = patch.scripts;
      if (patch.network !== undefined) body["network"] = patch.network;
      return (await postJson(io, `/api/doc/${encoded}/permissions`, body, isPermissionsReply))
        .permissions;
    },
    postNormalize: async () => {
      await postJson(io, `/api/doc/${encoded}/normalize`, {}, isNormalizeResponse);
    },
    fetchThemes: bind(`/api/theme`, assertThemeList),
    postStyle: async (visualId) => {
      await postJson(io, `/api/style`, { docId, visualId }, isStyleResponse);
    },
    annotate: {
      io: {
        mint: async () =>
          (await postJson(io, `/api/doc/${encoded}/annotate`, {}, isAnnotateReply)).frameUrl,
        list: async () => sidecarListOf(await io.json(`/api/doc/${encoded}/sidecar`, isAnyRecord)),
        add: async (body: { anchor: WireAnchor; selector?: string; note: string }) => {
          await postJson(
            io,
            `/api/doc/${encoded}/sidecar`,
            body as Readonly<Record<string, unknown>>,
            isAnyRecord,
          );
        },
      },
      env: annotateEnvOf(),
      panel: {
        io: {
          resolve: async (id) => {
            await postJson(
              io,
              `/api/doc/${encoded}/sidecar/${encodeURIComponent(id)}/resolve`,
              {},
              isAnyRecord,
            );
          },
          reopen: async (id) => {
            await postJson(
              io,
              `/api/doc/${encoded}/sidecar/${encodeURIComponent(id)}/reopen`,
              {},
              isAnyRecord,
            );
          },
          reply: async (id, note) => {
            await postJson(
              io,
              `/api/doc/${encoded}/sidecar/${encodeURIComponent(id)}/reply`,
              { note },
              isAnyRecord,
            );
          },
          remove: async (id) => {
            await postJson(
              io,
              `/api/doc/${encoded}/sidecar/${encodeURIComponent(id)}/delete`,
              {},
              isAnyRecord,
            );
          },
        },
      },
    },
  });
};

/**
 * Annotate mode's message/geometry env: `contentWindow` and `getBoundingClientRect`
 * never pass through Host (they are not write points) — narrowed structurally exactly once
 * here (`@internal`: tests inject a fake env).
 */
interface FrameElementLike {
  readonly contentWindow?: {
    readonly postMessage: (message: unknown, targetOrigin: string) => void;
  } | null;
  readonly getBoundingClientRect?: () => {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

const annotateEnvOf = (): AnnotateEnv => {
  const frameEl = (): FrameElementLike | undefined =>
    (document.querySelector("#hr-foreign-frame") as FrameElementLike | null) ?? undefined;
  return {
    onMessage: (handler) => {
      const listener = (event: {
        readonly source?: unknown;
        readonly origin?: string;
        readonly data?: unknown;
      }): void => {
        handler({
          source: event.source,
          origin: typeof event.origin === "string" ? event.origin : "",
          data: event.data,
        });
      };
      window.addEventListener("message", listener);
      return () => {
        window.removeEventListener("message", listener);
      };
    },
    frameWindow: () => frameEl()?.contentWindow ?? null,
    postToFrame: (message) => {
      frameEl()?.contentWindow?.postMessage(message, "*");
    },
    frameRect: () => {
      const rect = frameEl()?.getBoundingClientRect?.();
      return rect === undefined
        ? undefined
        : { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    },
    viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
  };
};

/** 顶层兜底：任何失败都在中栏写一条可读文案，不白屏（`@internal` 便于单测）。 */
export const reportFailure = (host: Host, error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error);
  host.text("#hr-doc", `打开失败：${message}`);
};

/** 缺省的可视面：真 `document`。测试注入假 host 时完全不读全局。 */
const defaultHost = (): Host => createDomHost(document);

export interface DocIdSource {
  readonly attr: string | null;
  readonly href: string;
}

/** 从页面注入点取 docId：`data-doc-id` 优先，其次 `?doc=`。 */
export const docIdOf = (source: DocIdSource): string => {
  if (source.attr !== null && source.attr !== "") return source.attr;
  const fromUrl = new URL(source.href).searchParams.get("doc");
  return fromUrl ?? "";
};

export const main = async (options: MainOptions = {}): Promise<void> => {
  const host = options.host ?? defaultHost();
  const io = options.io ?? createHttpIo();
  const source = options.docIdSource ?? {
    attr: document.body.getAttribute("data-doc-id"),
    href: window.location.href,
  };
  const docId = docIdOf(source);
  if (docId === "") {
    host.text("#hr-doc", "没有指定文档：用 /?doc=<docId> 打开");
    return;
  }
  const booted = await bootDocumentWith({ docId, io, host });
  // 划词 → 选区描述：字符偏移用 Range 量，跨块用"最近块祖先"判定。
  window.addEventListener("mouseup", () => {
    const raw = rawSelectionOf(window.getSelection?.() ?? null, measureSelection());
    if (raw !== undefined) booted.selection?.(raw);
  });
  // 真页面卸载时拆掉监听与连接（`main.ts` 的 destroy 因此可达）。
  window.addEventListener("pagehide", () => {
    booted.destroy();
  });
};

// 入口：模块被加载就地开跑（测试的 stub 在 import 前装好，行为与上一版一致）。
void main().catch((error: unknown) => {
  // main 的失败本身就可能起于"没有 document"（node/测试环境动态 import）——那时连
  // 上报的可视面都不存在，再造 host 只会从 catch 里再抛一个未处理拒绝。
  if (typeof document === "undefined") return;
  reportFailure(defaultHost(), error);
});
