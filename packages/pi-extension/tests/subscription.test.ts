// 这层管：`/api/events` 订阅——认证头、`Last-Event-ID`（含 `id: 0` 不得入缓存）、`reset` 降级、
// 断线重连、`stop()` 真停（Pi 退出时不能挂住进程）。

import { describe, expect, it } from "vitest";

import { delayOf, subscribeOf, type DaemonInfo, type HreaderEvent } from "../pi-hreader.ts";
import { fakeDepsOf } from "./fakes.ts";
import {
  holdDelayOf,
  scriptedFetchOf,
  settleOf,
  steppedDelayOf,
  type ScriptedReply,
} from "./sse-fakes.ts";

const INFO: DaemonInfo = { port: 7331, token: "tok-1", pid: 4242, workspace: "/work" };
const READY = 'retry: 2000\nid: 0\ndata: {"type":"ready"}\n\n';
const DOC_CHANGED = 'id: 7\ndata: {"type":"doc.changed","docId":"docs/a.html","revision":2}\n\n';
const RESET = 'data: {"type":"reset","reason":"events_expired"}\n\n';
const UNKNOWN = 'id: 9\ndata: {"type":"applause"}\n\n';

interface Counter {
  count: number;
}

/** 在脚本回复上挂 `cancel` 计数：`cancel()` 是否真落到 body 上，只能这样观测。 */
const cancellingOf = (reply: ScriptedReply, counter: Counter): ScriptedReply => ({
  ...reply,
  onCancel: () => {
    counter.count += 1;
  },
});

/** 监听未处理 rejection 跑一段，返回期间收到的 reason（收尾一定摘掉监听）。 */
const rejectionsDuringOf = async (run: () => Promise<void>): Promise<readonly unknown[]> => {
  const seen: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on("unhandledRejection", onRejection);
  try {
    await run();
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  return seen;
};

const driveOf = async (
  replies: readonly ScriptedReply[],
  options: { readonly delay?: (ms: number, signal: AbortSignal) => Promise<void> } = {},
) => {
  const script = scriptedFetchOf(replies);
  const { deps } = fakeDepsOf({
    fetch: script.fetch,
    delay: options.delay ?? holdDelayOf(),
  });
  const events: HreaderEvent[] = [];
  const stales: string[] = [];
  const downs: number[] = [];
  const bads: string[] = [];
  const subscription = subscribeOf(deps, INFO, {
    onEvent: (event) => events.push(event),
    onStale: () => stales.push("stale"),
    onDown: () => downs.push(1),
    onBadFrame: (detail) => bads.push(detail),
  });
  await settleOf();
  return { calls: script.calls, events, stales, downs, bads, subscription };
};

describe("subscribeOf 的连接与认证", () => {
  it("连 `/api/events`，带 `Cookie: hr=<token>`（cookie 的值就是 daemon token）", async () => {
    const { calls, events, subscription } = await driveOf([
      { chunks: [READY + DOC_CHANGED], keepOpen: true },
    ]);
    subscription.stop();
    expect(calls[0]?.url).toBe("http://127.0.0.1:7331/api/events");
    expect(calls[0]?.request.method).toBe("GET");
    expect(calls[0]?.request.headers["cookie"]).toBe("hr=tok-1");
    expect(calls[0]?.request.headers["accept"]).toBe("text/event-stream");
    expect(calls[0]?.request.headers["last-event-id"]).toBeUndefined();
    expect(events.map((event) => event.type)).toEqual(["doc.changed"]);
  });

  it("首连不写 CSRF 头（读端点不吃 `x-hr-csrf`）", async () => {
    const { calls, subscription } = await driveOf([{ chunks: [READY], keepOpen: true }]);
    subscription.stop();
    expect(calls[0]?.request.headers["x-hr-csrf"]).toBeUndefined();
  });
});

describe("subscribeOf 的帧去向", () => {
  it("`reset` 帧走降级提示，不进业务事件（不许被未知类型吞掉）", async () => {
    const { events, stales, subscription } = await driveOf([{ chunks: [RESET], keepOpen: true }]);
    subscription.stop();
    expect(stales).toHaveLength(1);
    expect(events).toEqual([]);
  });

  it("四个业务类型之外的类型被忽略，且**不报**成坏帧（`applause` 与坏帧必须可区分）", async () => {
    const { bads, events, subscription } = await driveOf([
      { chunks: [READY + UNKNOWN], keepOpen: true },
    ]);
    subscription.stop();
    expect(events).toEqual([]);
    expect(bads).toEqual([]);
  });

  it("`id:` 原样交给调用方（`Last-Event-ID` 的候选）", async () => {
    const { events, subscription } = await driveOf([{ chunks: [DOC_CHANGED], keepOpen: true }]);
    subscription.stop();
    expect(events[0]?.id).toBe("7");
    expect(events[0]?.payload["docId"]).toBe("docs/a.html");
  });
});

describe("subscribeOf 的断线重连", () => {
  it("断流后重连带 `Last-Event-ID`", async () => {
    const { calls, downs, subscription } = await driveOf(
      [{ chunks: [DOC_CHANGED] }, { chunks: [], keepOpen: true }],
      { delay: steppedDelayOf(1) },
    );
    subscription.stop();
    expect(downs).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.request.headers["last-event-id"]).toBe("7");
  });

  it("`ready` 的 `id: 0` 不得当 `Last-Event-ID`（它不在环里）", async () => {
    const { calls, subscription } = await driveOf(
      [{ chunks: [READY] }, { chunks: [], keepOpen: true }],
      { delay: steppedDelayOf(1) },
    );
    subscription.stop();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.request.headers["last-event-id"]).toBeUndefined();
  });

  it("HTTP 非 2xx 也按断线处理并重连", async () => {
    const { calls, downs, subscription } = await driveOf(
      [{ status: 401 }, { chunks: [], keepOpen: true }],
      { delay: steppedDelayOf(1) },
    );
    subscription.stop();
    expect(downs).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });
});

describe("subscribeOf 的异常与弃帧", () => {
  it("`fetch` 抛错（daemon 退出）不把异常抛给 Pi，只走重连", async () => {
    const { deps } = fakeDepsOf({
      fetch: () => Promise.reject(new Error("ECONNREFUSED")),
      delay: steppedDelayOf(0),
    });
    const downs: number[] = [];
    const subscription = subscribeOf(deps, INFO, {
      onEvent: () => undefined,
      onStale: () => undefined,
      onDown: () => downs.push(1),
      onBadFrame: () => undefined,
    });
    await settleOf();
    subscription.stop();
    expect(downs).toHaveLength(1);
  });

  it("帧的 `data` 不是带 `type` 的 JSON：丢掉这一帧，但报出原文（不许静默吞掉协议漂移）", async () => {
    const { bads, events, subscription } = await driveOf([
      { chunks: [`data: 不是 JSON\n\ndata: {"no":"type"}\n\n${UNKNOWN}`] },
    ]);
    subscription.stop();
    expect(events).toEqual([]);
    // 前两帧都是坏帧，但同一订阅只报一条（节流）；原文必须原样带出来。
    expect(bads).toEqual(["不是 JSON"]);
  });
});

describe("坏帧判定与节流", () => {
  it("垃圾帧逐个判：非 JSON / 无 type / 非对象 各报一条；未知类型的 JSON 不报", async () => {
    const cases = [
      { frame: "data: 不是 JSON\n\n", bad: true },
      { frame: 'data: {"no":"type"}\n\n', bad: true },
      { frame: "data: 123\n\n", bad: true },
      { frame: 'data: {"type":"applause"}\n\n', bad: false },
    ];
    for (const one of cases) {
      const { bads, events, subscription } = await driveOf([
        { chunks: [one.frame], keepOpen: true },
      ]);
      subscription.stop();
      expect(events, one.frame).toEqual([]);
      expect(bads, one.frame).toHaveLength(one.bad ? 1 : 0);
    }
  });

  it("坏帧上报有节流：50 个坏帧只报一条（一坏帧一提示会永久刷屏）", async () => {
    const frames = Array.from({ length: 50 }, () => "data: 不是 JSON\n\n");
    const { bads, subscription } = await driveOf([{ chunks: [frames.join("")] }]);
    subscription.stop();
    expect(bads).toHaveLength(1);
  });

  it("重连后流健康过一次，再坏可以再报一条（节流不是一次性闸门）", async () => {
    const { bads, subscription } = await driveOf(
      [
        { chunks: ["data: 不是 JSON\n\n"] },
        { chunks: [`${DOC_CHANGED}data: 不是 JSON\n\n`], keepOpen: true },
      ],
      { delay: steppedDelayOf(1) },
    );
    await settleOf(12);
    subscription.stop();
    expect(bads).toHaveLength(2);
  });
});

describe("读流收尾（连接不许泄漏）", () => {
  it("溢出弃帧也要关掉 body：cancel 恰好 1 次（不靠 abort 那条唯一路径）", async () => {
    const counter: Counter = { count: 0 };
    const flood = `data: {"x":"${"y".repeat(1024 * 1024 + 16)}`;
    const { downs, subscription } = await driveOf([
      cancellingOf({ chunks: [flood], keepOpen: true }, counter),
    ]);
    await settleOf(4);
    subscription.stop();
    await settleOf(4);
    expect(downs).toHaveLength(1);
    expect(counter.count).toBe(1);
  });

  it("abort 与 finally 不会各关一次：同一个 reader 的 cancel 恰好 1 次", async () => {
    const counter: Counter = { count: 0 };
    const { subscription } = await driveOf([
      cancellingOf({ chunks: [DOC_CHANGED], keepOpen: true }, counter),
    ]);
    subscription.stop();
    await settleOf(4);
    expect(counter.count).toBe(1);
  });

  it("`cancel()` 抛错不会变成未处理的 rejection（Node 24 默认会带崩进程）", async () => {
    const seen = await rejectionsDuringOf(async () => {
      const { subscription } = await driveOf([
        { chunks: [READY], keepOpen: true, cancelThrows: true },
      ]);
      subscription.stop();
      await settleOf(8);
    });
    expect(seen).toEqual([]);
  });
});

describe("subscribeOf 的收尾", () => {
  it("`stop()` 会中断读流：不再重连、不触发 onDown", async () => {
    const { calls, downs, subscription } = await driveOf([
      { chunks: [DOC_CHANGED], keepOpen: true },
    ]);
    subscription.stop();
    await settleOf(4);
    expect(calls).toHaveLength(1);
    expect(downs).toEqual([]);
  });

  it("重连等待可被 abort 打断：`stop()` 之后进程不会被定时器留住", async () => {
    const controller = new AbortController();
    const waiting = delayOf(60_000, controller.signal);
    controller.abort();
    await expect(waiting).resolves.toBeUndefined();
  });

  it("重连等待到点自己结束；signal 已经 abort 时立刻返回", async () => {
    const alive = new AbortController();
    await expect(delayOf(1, alive.signal)).resolves.toBeUndefined();
    alive.abort();
    await expect(delayOf(60_000, alive.signal)).resolves.toBeUndefined();
  });
});
