// 这层管：唯一的浏览器入口——把真 `document`/`fetch`/`EventSource`/`window` 塞进纯层。
// **除了这个文件与 `dom.ts`，`packages/app/src` 没有别的地方碰全局。**

import { boot, type ModelResponse, type OutlineResponse } from "./boot.ts";
import { createDomHost, type DocumentLike, type Host } from "./dom.ts";
import type { KeyLike } from "./keys.ts";
import { createSse, type SseHandlers, type SourceLike } from "./sse.ts";
import { initialState } from "./state.ts";
import { createStore } from "./store.ts";
import { createStyleSwitch } from "./style-switch.ts";

/** 浏览器全局的最小声明（本仓库 tsconfig 不带 DOM lib）：只写我们真正用到的成员。 */
declare const document: DocumentLike;
declare const window: {
  readonly location: { readonly href: string };
  readonly addEventListener: (type: string, listener: (event: KeyboardLike) => void) => void;
  readonly removeEventListener: (type: string, listener: (event: KeyboardLike) => void) => void;
};
declare const EventSource: new (
  url: string,
  init?: { withCredentials?: boolean },
) => BrowserEventSource;

/** `keydown` 事件只读这四个字段。 */
interface KeyboardLike {
  readonly key: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly target?: { readonly tagName?: string; readonly isContentEditable?: boolean } | null;
}

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

/** 页面需要的两类 IO：文本与"带守卫的 JSON"。注入点只在这一层。 */
export interface AppIo {
  readonly text: (path: string) => Promise<string>;
  readonly json: <T>(path: string, guard: (value: unknown) => value is T) => Promise<T>;
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

/** 缺省的 `AppIo`：真 `fetch`（`@internal`：测试可换掉它，不必起服务器）。 */
export const createHttpIo = (): AppIo => ({
  text: async (path) => {
    const response = await fetch(path, { credentials: "same-origin" });
    if (!response.ok) throw new Error(`${path} → ${String(response.status)}`);
    return await response.text();
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

const keySourceOf = (handler: (event: KeyLike) => void): (() => void) => {
  const listener = (event: KeyboardLike): void => {
    handler({
      key: event.key,
      metaKey: event.metaKey === true,
      ctrlKey: event.ctrlKey === true,
      altKey: event.altKey === true,
      target: event.target ?? null,
    });
  };
  window.addEventListener("keydown", listener);
  return () => {
    window.removeEventListener("keydown", listener);
  };
};

/** `data-doc-id` 优先，其次 `?doc=`（`href` 可注入，方便测 URL 分支）。 */
export const docIdOf = (source: {
  readonly attr: string | null;
  readonly href: string;
}): string => {
  if (source.attr !== null && source.attr !== "") return source.attr;
  const fromUrl = new URL(source.href).searchParams.get("doc");
  return fromUrl ?? "";
};

/** 组装 `boot` 的依赖；IO 全部走注入（`@internal`：测试用假 io 驱动每一条分支）。 */
export interface BootInput {
  readonly docId: string;
  readonly themes: ThemeList;
  readonly documentHtml: string;
  readonly io: AppIo;
  readonly host: Host;
}

export const bootWith = (input: BootInput): ReturnType<typeof boot> => {
  const { docId, themes, documentHtml, io, host } = input;
  const encoded = encodeURIComponent(docId);
  const bind = <T>(path: string, guard: (value: unknown) => value is T): (() => Promise<T>) => {
    return async () => await io.json(path, guard);
  };
  return boot({
    host,
    store: createStore(initialState(docId, themes.default)),
    openSse,
    style: createStyleSwitch({
      loadCss: (id) => io.text(`/api/theme/${encodeURIComponent(id)}`),
      applyCss: (css) => {
        host.text("#hr-theme", css);
      },
    }),
    documentHtml,
    themes: themes.themes,
    defaultTheme: themes.default,
    fetchDocument: async () => await io.text(`/s/${encoded}`),
    fetchModel: bind(`/api/doc/${encoded}/model`, isModelResponse),
    fetchOutline: bind(`/api/doc/${encoded}/outline`, isOutlineResponse),
    keySource: keySourceOf,
  });
};

/** 顶层兜底（裁定 #13）：任何失败都在中栏写一条可读文案，不白屏（`@internal` 便于单测）。 */
export const reportFailure = (host: Host, error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error);
  host.text("#hr-doc", `打开失败：${message}`);
};

/** 缺省的可视面：真 `document`。测试注入假 host 时完全不读全局。 */
const defaultHost = (): Host => createDomHost(document);

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
  const encoded = encodeURIComponent(docId);
  const [themes, html] = await Promise.all([
    io.json("/api/theme", assertThemeList),
    io.text(`/s/${encoded}`),
  ]);
  const booted = bootWith({ docId, themes, documentHtml: html, io, host });
  // 真页面卸载时拆掉监听与连接（`main.ts` 的 destroy 因此可达，P0-4）。
  window.addEventListener("pagehide", () => {
    booted.destroy();
  });
};

// 入口：模块被加载就地开跑（测试的 stub 在 import 前装好，行为与上一版一致）。
void main().catch((error: unknown) => {
  reportFailure(defaultHost(), error);
});
