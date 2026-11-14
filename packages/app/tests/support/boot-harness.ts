// 这层管：`boot` 测试的共享夹具（假 Host / 假 Sse / 假时钟泵 + 计数 store）。
// 测试文件只保留用例本身，规模门（≤300 行）与函数门（≤40 行）才过得去。

import type { BootDeps, OutlineResponse } from "../../src/boot.ts";
import type { SseEvent, SseHandlers } from "../../src/sse.ts";
import { initialState, type ReaderIntent, type ReaderState } from "../../src/state.ts";
import { createStore, type Store } from "../../src/store.ts";
import { captureUnhandled, createFakeHost, recordingStore, type FakeHost } from "./fake-host.ts";

export { captureUnhandled, recordingStore };
export type { ReaderState };
export type { BootDeps, ReaderIntent, SseEvent };

interface Counters {
  document: number;
  model: number;
  outline: number;
}

export interface Harness {
  readonly deps: BootDeps;
  readonly store: Store;
  readonly fake: FakeHost;
  readonly keyHandlers: ((event: { key: string }) => void)[];
  readonly selectCalls: { theme: string; current: string }[];
  readonly fetched: Counters;
  readonly closed: () => boolean;
  readonly keysBound: () => number;
  readonly emit: (event: SseEvent) => void;
  readonly type: (key: string) => void;
}

export const outlineOf = (): OutlineResponse => ({
  outline: { nodes: [{ id: "hr-a", level: 1, text: "一" }] },
});

interface Sink {
  readonly counters: Counters;
  readonly flags: { sseClosed: boolean; keys: number };
  readonly keys: ((event: { key: string }) => void)[];
  readonly selectCalls: { theme: string; current: string }[];
}

/** 三个读接口各记一次调用，写在一起比在 `transportOf` 里堆三段长。 */
const fetchTripleOf = (
  counters: Counters,
): Pick<BootDeps, "fetchDocument" | "fetchModel" | "fetchOutline"> => ({
  fetchDocument: () => {
    counters.document += 1;
    return Promise.resolve("<p>二</p>");
  },
  fetchModel: () => {
    counters.model += 1;
    return Promise.resolve({ revision: "r1", model: { children: [{ id: "hr-a" }, {}] } });
  },
  fetchOutline: () => {
    counters.outline += 1;
    return Promise.resolve(outlineOf());
  },
});

/** SSE/主题/IO 三组依赖各自独立，`harnessOf` 只做拼装。 */
const transportOf = (
  sink: Sink,
  styleOk: boolean,
): Pick<
  BootDeps,
  "openSse" | "style" | "keySource" | "fetchDocument" | "fetchModel" | "fetchOutline"
> => ({
  openSse: () => ({
    start: () => undefined,
    close: () => {
      sink.flags.sseClosed = true;
    },
  }),
  style: {
    select: (theme, current) => {
      sink.selectCalls.push({ theme, current });
      return Promise.resolve(
        styleOk
          ? { status: "applied", id: theme }
          : { status: "failed", id: theme, message: "load failed" },
      );
    },
  },
  keySource: (handler) => {
    sink.flags.keys += 1;
    sink.keys.push(handler);
    return () => {
      sink.flags.keys -= 1;
    };
  },
  ...fetchTripleOf(sink.counters),
});

const composeDeps = (
  fake: FakeHost,
  store: Store,
  transport: Pick<
    BootDeps,
    "openSse" | "style" | "keySource" | "fetchDocument" | "fetchModel" | "fetchOutline"
  >,
  handlersRef: { current?: SseHandlers },
): BootDeps => ({
  host: fake.host,
  store,
  openSse: (next) => {
    handlersRef.current = next;
    return transport.openSse(next);
  },
  style: transport.style,
  documentHtml: "<p>一</p>",
  themes: ["atelier-editorial"],
  fetchDocument: transport.fetchDocument,
  fetchModel: transport.fetchModel,
  fetchOutline: transport.fetchOutline,
  keySource: transport.keySource,
});

export const harnessOf = (styleOk: boolean): Harness => {
  const fake = createFakeHost();
  const store = createStore({ ...initialState("doc.html", "atelier-editorial"), blocks: ["hr-a"] });
  const sink: Sink = {
    counters: { document: 0, model: 0, outline: 0 },
    flags: { sseClosed: false, keys: 0 },
    keys: [],
    selectCalls: [],
  };
  const handlersRef: { current?: SseHandlers } = {};
  const deps = composeDeps(fake, store, transportOf(sink, styleOk), handlersRef);
  return {
    deps,
    store,
    fake,
    keyHandlers: sink.keys,
    selectCalls: sink.selectCalls,
    fetched: sink.counters,
    closed: () => sink.flags.sseClosed,
    keysBound: () => sink.flags.keys,
    emit: (event) => {
      handlersRef.current?.onEvent(event);
    },
    type: (key) => {
      for (const handler of sink.keys) handler({ key });
    },
  };
};

/** 在 `createStore` 外面套一层：记录 `subscribe` 的调用与返回的退订函数是否被调用。 */
export const countingStore = (
  inner: Store,
): { store: Store; counts: { subscribe: number; off: number } } => {
  const counts = { subscribe: 0, off: 0 };
  return {
    counts,
    store: {
      get: () => inner.get(),
      dispatch: (intent) => {
        inner.dispatch(intent);
      },
      subscribe: (listener) => {
        counts.subscribe += 1;
        const off = inner.subscribe(listener);
        return () => {
          counts.off += 1;
          off();
        };
      },
    },
  };
};

export const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

export const blocksOf = (state: ReaderState): readonly string[] => state.blocks;
