// 这层管：`main.ts` 的浏览器桩与响应工厂——`main.test.ts` 与 `main-guards.test.ts` 共用。
// 桩必须在 import `main.ts` **之前**装好（入口末尾立刻跑 `main()`）。

import { vi } from "vitest";

import { createFakeDocument, fakeElement, type FakeDocument } from "./fake-dom.ts";

export interface KeyboardLike {
  readonly key: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  /** 真 `KeyboardEvent` 必带；`Shift+D` 的 diff 路由靠它（`keys.ts` 读 `shiftKey === true`）。 */
  readonly shiftKey?: boolean;
  readonly target?: unknown;
  readonly preventDefault?: () => void;
}

export interface BrowserStubs {
  doc: FakeDocument;
  sources: FakeSource[];
  keyHandlers: ((event: KeyboardLike) => void)[];
  pagehide: ((event: KeyboardLike) => void)[];
  mouseups: (() => void)[];
  fetched: string[];
  /** 每次 `fetch` 的原始入参（用来断言 POST 的 JSON 正文）。 */
  requests: { url: string; method: string; body: unknown }[];
  /** `window.getSelection()` 的返回值（默认 null；用例可换成真选区）。 */
  selection: unknown;
  closed: number;
  removed: number;
}

export class FakeSource {
  readonly url: string;
  readonly withCredentials: boolean;
  readonly listeners = new Map<string, (event: { data: string; lastEventId?: string }) => void>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = init?.withCredentials === true;
  }
  addEventListener(
    type: string,
    listener: (event: { data: string; lastEventId?: string }) => void,
  ): void {
    this.listeners.set(type, listener);
  }
  close(): void {
    stubs.closed += 1;
  }
  fire(type: string, data: string, lastEventId?: string): void {
    const event = lastEventId === undefined ? { data } : { data, lastEventId };
    this.listeners.get(type)?.(event);
  }
}

export const stubs: BrowserStubs = {
  doc: createFakeDocument(),
  sources: [],
  keyHandlers: [],
  pagehide: [],
  mouseups: [],
  fetched: [],
  requests: [],
  selection: null,
  closed: 0,
  removed: 0,
};

export const jsonOf = (value: unknown): Response =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
export const textOf = (value: string): Response => new Response(value, { status: 200 });
export const failOf = (status: number): Response => new Response("{}", { status });

export const installGlobals = (
  bodyDocId: string | null,
  href: string,
  options: { readonly withGetSelection?: boolean } = {},
): void => {
  const doc = createFakeDocument();
  doc.body.getAttribute = () => bodyDocId;
  stubs.doc = doc;
  stubs.sources = [];
  stubs.keyHandlers = [];
  stubs.pagehide = [];
  stubs.mouseups = [];
  stubs.fetched = [];
  stubs.requests = [];
  stubs.selection = null;
  stubs.closed = 0;
  stubs.removed = 0;
  vi.stubGlobal("document", {
    body: doc.body,
    querySelector: doc.querySelector,
    createElement: doc.createElement,
  });
  vi.stubGlobal("window", {
    location: { href },
    addEventListener: (type: string, listener: (event: KeyboardLike) => void) => {
      if (type === "keydown") stubs.keyHandlers.push(listener);
      if (type === "pagehide") stubs.pagehide.push(listener);
      if (type === "mouseup")
        stubs.mouseups.push(() => {
          listener({ key: "" });
        });
    },
    // `withGetSelection: false` 用来测 `window.getSelection?.()` 的**缺失臂**（主端只做可选调用）。
    ...(options.withGetSelection === false ? {} : { getSelection: () => stubs.selection }),
    removeEventListener: () => {
      stubs.removed += 1;
    },
  });
  installEventSource();
};

const installEventSource = (): void => {
  vi.stubGlobal(
    "EventSource",
    class {
      readonly inner: FakeSource;
      constructor(url: string, init?: { withCredentials?: boolean }) {
        this.inner = new FakeSource(url, init);
        stubs.sources.push(this.inner);
      }
      addEventListener(
        type: string,
        listener: (event: { data: string; lastEventId?: string }) => void,
      ): void {
        this.inner.addEventListener(type, listener);
      }
      set onopen(listener: (() => void) | null) {
        this.inner.onopen = listener;
      }
      get onopen(): (() => void) | null {
        return this.inner.onopen;
      }
      set onerror(listener: (() => void) | null) {
        this.inner.onerror = listener;
      }
      get onerror(): (() => void) | null {
        return this.inner.onerror;
      }
      close(): void {
        this.inner.close();
      }
    },
  );
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

/** `fetch` 的 init 只看 method/body；类型收窄在这里，避免把 `any` 漏进用例。 */
const methodOf = (init: unknown): string => {
  if (!isRecord(init)) return "GET";
  const method = init["method"];
  return typeof method === "string" ? method : "GET";
};

const bodyOf = (init: unknown): unknown => (isRecord(init) ? init["body"] : undefined);

export const install = (
  bodyDocId: string | null,
  href: string,
  respond: (url: string) => Response,
  options: { readonly withGetSelection?: boolean } = {},
): void => {
  installGlobals(bodyDocId, href, options);
  vi.stubGlobal("fetch", (url: string, init?: unknown) => {
    stubs.fetched.push(url);
    stubs.requests.push({ url, method: methodOf(init), body: bodyOf(init) });
    return Promise.resolve(respond(url));
  });
};

export const themes = { themes: ["atelier-editorial", "manuscript"], default: "atelier-editorial" };
export const model = { revision: "r1", model: { children: [{ id: "hr-a" }] } };
export const outline = { outline: { nodes: [{ id: "hr-a", level: 1, text: "一" }] } };
export const ARTICLE = "<article data-hr-id='hr-a'><p>一</p></article>";
export const CSS = ":root{--ink:#111}";

export const happy = (url: string): Response => {
  if (url === "/api/theme") return jsonOf(themes);
  if (url.startsWith("/api/theme/")) return textOf(CSS);
  if (url.endsWith("/model")) return jsonOf(model);
  if (url.endsWith("/outline")) return jsonOf(outline);
  if (url.endsWith("/annotations"))
    return jsonOf({
      annotations: [
        {
          id: "an-1a2b3c4d",
          nodeId: "hr-a",
          note: "批注",
          status: "pending",
          anchor: { exact: "一", prefix: "", suffix: "", start: 0 },
          createdAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      lost: [],
    });
  // 与服务端契约同形（`guard.isDiffResponse`）：假件不得比真实响应更宽松。
  if (url.endsWith("/diff"))
    return jsonOf({
      nodeId: "hr-a",
      before: "一",
      after: "一新段落",
      chunks: [{ kind: "ins", text: "新段落" }],
      degraded: false,
    });
  return textOf(ARTICLE);
};

export const flush = async (ms = 0): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

export const load = async (): Promise<void> => {
  vi.resetModules();
  await import("../../src/main.ts");
  await flush();
  await flush();
};

export const noticeOf = async (respond: (url: string) => Response): Promise<string> => {
  install("doc.html", "http://x/", respond);
  stubs.doc.bySelector.set("#hr-doc", fakeElement("div"));
  await load();
  return stubs.doc.bySelector.get("#hr-doc")?.textContent ?? "";
};
