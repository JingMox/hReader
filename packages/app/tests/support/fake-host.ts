// 这层管：`Host` 的假实现——记录**调用序列**（不是最终 DOM），"只写变化"
// 必须靠序列证明：整篇重载与按块更新在最终 DOM 上可能一样，在调用序列上不一样。

import type { Host, NodeSpec, TargetLike } from "../../src/dom.ts";
import {
  initialState,
  type OutlineNode,
  type ReaderIntent,
  type ReaderState,
} from "../../src/state.ts";
import type { Store } from "../../src/store.ts";

export interface HostCall {
  readonly op: string;
  readonly args: readonly string[];
}

export interface FakeHost {
  readonly host: Host;
  readonly calls: readonly HostCall[];
  /** 只取操作名，断言"某操作没发生"时比逐条比参数更好读。 */
  readonly ops: () => readonly string[];
  /** 触发某个 `on` 注册的处理器（模拟点击/change）。 */
  readonly fire: (selector: string, type: string, target: TargetLike) => void;
  /** 某个 selector 上注册过的事件类型。 */
  readonly listeners: () => readonly string[];
}

const textOpsOf = (
  calls: HostCall[],
): Pick<Host, "text" | "attr" | "html" | "cls" | "scrollTo"> => {
  const record = (op: string, args: readonly string[]): void => {
    calls.push({ op, args });
  };
  return {
    text: (selector, value) => {
      record("text", [selector, value]);
    },
    attr: (selector, name, value) => {
      record("attr", [selector, name, value ?? "<removed>"]);
    },
    html: (selector, markup) => {
      record("html", [selector, markup]);
    },
    cls: (selector, name, on) => {
      record("cls", [selector, name, on ? "1" : "0"]);
    },
    scrollTo: (selector) => {
      record("scrollTo", [selector]);
    },
  };
};

const treeOpsOf = (
  calls: HostCall[],
  handlers: Map<string, (target: TargetLike) => void>,
  blocksOf: (markup: string) => ReadonlyMap<string, string>,
): Pick<Host, "children" | "blocks" | "blockHtml" | "removeBlock" | "on" | "destroy"> => ({
  ...shapeOpsOf(calls, blocksOf),
  ...eventsOpsOf(calls, handlers),
});

const shapeOpsOf = (
  calls: HostCall[],
  blocksOf: (markup: string) => ReadonlyMap<string, string>,
): Pick<Host, "children" | "blocks" | "blockHtml" | "removeBlock"> => {
  const record = (op: string, args: readonly string[]): void => {
    calls.push({ op, args });
  };
  return {
    children: (selector, specs: readonly NodeSpec[]) => {
      record("children", [selector, JSON.stringify(specs)]);
    },
    blocks: (markup) => {
      record("blocks", [markup]);
      return blocksOf(markup);
    },
    blockHtml: (id, markup) => {
      record("blockHtml", [id, markup]);
    },
    removeBlock: (id) => {
      record("removeBlock", [id]);
    },
  };
};

// 与 `createDomHost` 的适配器同形：把 `closest` 预解析成 `tocId`（widget 只读 tocId）。
const eventsOpsOf = (
  calls: HostCall[],
  handlers: Map<string, (target: TargetLike) => void>,
): Pick<Host, "on" | "destroy"> => {
  const record = (op: string, args: readonly string[]): void => {
    calls.push({ op, args });
  };
  return {
    on: (selector, type, handler) => {
      record("on", [selector, type]);
      const adapted = (target: TargetLike): void => {
        handler({
          ...target,
          tocId:
            target.tocId ??
            target.closest?.("[data-toc-id]")?.getAttribute("data-toc-id") ??
            undefined,
          blockId:
            target.blockId ??
            target.closest?.("[data-hr-id]:not(article)")?.getAttribute("data-hr-id") ??
            undefined,
        });
      };
      handlers.set(`${selector}|${type}`, adapted);
      return () => {
        handlers.delete(`${selector}|${type}`);
        record("off", [selector, type]);
      };
    },
    destroy: () => {
      record("destroy", []);
    },
  };
};

export const createFakeHost = (
  blocksOf: (markup: string) => ReadonlyMap<string, string> = () => new Map(),
): FakeHost => {
  const calls: HostCall[] = [];
  const handlers = new Map<string, (target: TargetLike) => void>();
  return {
    host: { ...textOpsOf(calls), ...treeOpsOf(calls, handlers, blocksOf) },
    calls,
    ops: () => calls.map((call) => call.op),
    listeners: () => [...handlers.keys()],
    fire: (selector, type, target) => {
      handlers.get(`${selector}|${type}`)?.(target);
    },
  };
};

export const outlineOf = (): readonly OutlineNode[] => [
  { id: "hr-a", level: 1, text: "第一节" },
  { id: "hr-b", level: 2, text: "小节", children: [{ id: "hr-c", level: 3, text: "细目" }] },
];

export const stateOf = (over: Partial<ReaderState> = {}): ReaderState => ({
  ...initialState("doc.html", "atelier-editorial"),
  blocks: ["hr-a", "hr-b"],
  outline: outlineOf(),
  ...over,
});

export const targetOf = (value: string): TargetLike => ({ value });

/** 捕获 `unhandledRejection`：`boot` 的泵没有 `catch`，刷新失败会漏到全局（已知 src 缺陷）。 */
export const captureUnhandled = (): { readonly seen: unknown[]; readonly stop: () => void } => {
  const seen: unknown[] = [];
  const listener = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on("unhandledRejection", listener);
  return {
    seen,
    stop: () => {
      process.off("unhandledRejection", listener);
    },
  };
};

/** 记录 dispatch 过的 intent，转发给真 store（用于断言"泵跑完了第二轮"）。 */
export const recordingStore = (inner: Store, intents: ReaderIntent[]): Store => ({
  ...inner,
  dispatch: (intent) => {
    intents.push(intent);
    inner.dispatch(intent);
  },
});
