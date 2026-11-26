// 这层管：SSE 生命周期——退避序列/抖动/上限、连上后重置、关闭后不再重连、旧 revision 丢弃。

import { describe, expect, it } from "vitest";

import { createSse, type MessageEventLike, type SourceLike } from "../src/sse.ts";
import type { ConnState } from "../src/state.ts";

interface Harness {
  readonly sse: ReturnType<typeof createSse>;
  readonly states: readonly ConnState[];
  readonly events: readonly { readonly id: number; readonly type: string }[];
  readonly opens: () => number;
  readonly closes: () => number;
  readonly delays: readonly number[];
  readonly emit: (type: string, raw: string, id?: string) => void;
  readonly fail: () => void;
  readonly open: () => void;
  readonly runTimer: () => void;
  readonly cancelled: () => number;
}

interface Recorder {
  readonly states: ConnState[];
  readonly events: { id: number; type: string }[];
  readonly timers: { ms: number; run: () => void }[];
  readonly delays: number[];
  opened: number;
  closed: number;
  cancelled: number;
  message: ((event: MessageEventLike) => void) | undefined;
  listeners: Map<string, (event: MessageEventLike) => void>;
  fail: (() => void) | undefined;
  open: (() => void) | undefined;
}

const recorderOf = (): Recorder => ({
  states: [],
  events: [],
  timers: [],
  delays: [],
  opened: 0,
  closed: 0,
  cancelled: 0,
  message: undefined,
  listeners: new Map(),
  fail: undefined,
  open: undefined,
});

const sourceOf = (rec: Recorder): SourceLike => ({
  addEventListener: (type, listener) => {
    rec.listeners.set(type, listener);
    if (type === "message") rec.message = listener;
  },
  setOpen: (listener) => {
    rec.open = listener;
  },
  setError: (listener) => {
    rec.fail = listener;
  },
  close: () => {
    rec.closed += 1;
  },
});

const sseOf = (rec: Recorder, random: number) =>
  createSse(
    "/api/events",
    {
      open: () => {
        rec.opened += 1;
        return sourceOf(rec);
      },
      schedule: (ms, run) => {
        rec.delays.push(ms);
        rec.timers.push({ ms, run });
        return () => {
          rec.cancelled += 1;
        };
      },
      random: () => random,
    },
    {
      onEvent: (event) => rec.events.push({ id: event.id, type: event.type }),
      onState: (state) => rec.states.push(state),
    },
  );

const harness = (random = 0.5): Harness => {
  const rec = recorderOf();
  return {
    sse: sseOf(rec, random),
    states: rec.states,
    events: rec.events,
    opens: () => rec.opened,
    closes: () => rec.closed,
    delays: rec.delays,
    cancelled: () => rec.cancelled,
    emit: (type, raw, id) => {
      const listener = rec.listeners.get(type);
      const event = id === undefined ? { data: raw } : { data: raw, lastEventId: id };
      listener?.(event);
    },
    fail: () => {
      rec.fail?.();
    },
    open: () => {
      rec.open?.();
    },
    runTimer: () => {
      rec.timers[rec.timers.length - 1]?.run();
    },
  };
};

describe("createSse · 连接与事件", () => {
  it("should report connecting, open the source and switch to live", () => {
    const h = harness();
    h.sse.start();
    h.open();

    expect(h.states).toEqual(["connecting", "live"]);
    expect(h.opens()).toBe(1);
  });

  it("should deliver parsed events and ignore malformed frames", () => {
    const h = harness();
    h.sse.start();
    const frame = JSON.stringify({ n: 1 });
    h.emit("doc.changed", frame, "1");
    h.emit("doc.changed", "{not json", "2");
    h.emit("doc.changed", "[1,2]", "3");
    h.emit("doc.changed", frame, "1x");
    h.emit("doc.changed", frame, "4");
    h.emit("message", JSON.stringify({ type: "x", n: 2 }), "5");
    h.emit("doc.changed", "null", "6");

    expect(h.events).toEqual([
      { id: 1, type: "doc.changed" },
      { id: 4, type: "doc.changed" },
      { id: 5, type: "x" },
    ]);
  });

  it("should drop replayed or out-of-order event ids", () => {
    const h = harness();
    h.sse.start();
    const frame = JSON.stringify({ n: 1 });
    for (const id of [5, 5, 4, 6]) h.emit("doc.changed", frame, String(id));

    expect(h.events.map((event) => event.id)).toEqual([5, 6]);
  });
});

describe("createSse · 退避与重连", () => {
  it("should back off 1s, 2s, 4s … capped at 30s with ±20% jitter", () => {
    const h = harness(0.5); // 抖动命中中位 → 1000/2000/4000/…/30000
    h.sse.start();
    for (let attempt = 0; attempt < 7; attempt += 1) {
      h.fail();
      h.runTimer();
    }

    expect(h.delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(h.opens()).toBe(8);
  });
});

describe("createSse · 抖动与重置", () => {
  it("should clamp the jitter into [0.8×, 1.2×] for both random extremes", () => {
    const low = harness(0);
    low.sse.start();
    low.fail();
    const high = harness(1);
    high.sse.start();
    high.fail();

    expect(low.delays[0]).toBe(800);
    expect(high.delays[0]).toBe(1200);
  });

  it("should reset the backoff once a connection opens", () => {
    const h = harness(0.5);
    h.sse.start();
    h.fail(); // attempt 1 → 1000
    h.runTimer();
    h.open(); // 连上 → attempt 归零
    h.fail(); // 应重新从 1000 开始
    h.runTimer();

    expect(h.delays).toEqual([1000, 1000]);
    expect(h.states).toEqual(["connecting", "reconnecting", "live", "reconnecting"]);
  });

  it("should close the failed source before scheduling a retry", () => {
    const h = harness();
    h.sse.start();
    h.fail();

    expect(h.closes()).toBe(1);
  });
});

describe("createSse · 关闭清理", () => {
  it("should go offline, close the source and cancel the pending timer", () => {
    const h = harness();
    h.sse.start();
    h.fail();
    h.sse.close();

    expect(h.states).toEqual(["connecting", "reconnecting", "offline"]);
    expect(h.closes()).toBe(2);
    expect(h.cancelled()).toBe(1);
  });

  it("should not reconnect when an error arrives after close", () => {
    const h = harness();
    h.sse.start();
    h.fail(); // 先挂一个待触发的定时器
    h.sse.close();
    const delaysBefore = h.delays.length;
    h.fail(); // 关闭后的 error：只 close，不再 schedule

    expect(h.delays.length).toBe(delaysBefore);
    expect(h.cancelled()).toBe(1); // close 只取消了那一个挂起的定时器
  });
});

describe("createSse · 关闭之后的边界", () => {
  it("should not reopen a timer that fires after close", () => {
    const h = harness();
    h.sse.start();
    h.fail();
    h.sse.close();
    h.runTimer(); // 定时器已取消，但即便它真跑了也不能再连

    expect(h.opens()).toBe(1);
  });

  it("should allow restarting after close", () => {
    const h = harness();
    h.sse.start();
    h.sse.close();
    h.sse.start();

    expect(h.states).toEqual(["connecting", "offline", "connecting"]);
    expect(h.opens()).toBe(2);
  });
});

describe("sse · 帧头 id 为空或非数字", () => {
  it("should drop a frame whose id is empty", () => {
    const h = harness(0.5);
    h.sse.start();
    h.emit("message", JSON.stringify({ type: "doc.changed" }), "");
    h.emit("message", JSON.stringify({ type: "doc.changed" }), "12");
    expect(h.events).toEqual([{ id: 12, type: "doc.changed" }]);
    h.sse.close();
  });

  // 已知缺陷：`1e3` 走 `Number()` 被当成 1000，之后真帧 `12` 反而被判 stale 丢弃。
  it("should currently coerce a scientific-notation id through Number()", () => {
    const h = harness(0.5);
    h.sse.start();
    h.emit("message", JSON.stringify({ type: "doc.changed" }), "1e3");
    h.emit("message", JSON.stringify({ type: "doc.changed" }), "12");
    expect(h.events).toEqual([{ id: 1000, type: "doc.changed" }]);
    h.sse.close();
  });

  it("should drop a frame that has no `lastEventId` at all", () => {
    const h = harness(0.5);
    h.sse.start();
    h.emit("doc.changed", JSON.stringify({ changedNodes: [] }));
    h.emit("doc.changed", JSON.stringify({ changedNodes: [] }), "3");
    expect(h.events).toEqual([{ id: 3, type: "doc.changed" }]);
    h.sse.close();
  });

  it("should drop a frame whose `id:` header is not a number", () => {
    const h = harness(0.5);
    h.sse.start();
    h.emit("doc.changed", JSON.stringify({ changedNodes: [] }), "not-a-number");
    h.emit("doc.changed", JSON.stringify({ changedNodes: [] }), "4");
    expect(h.events).toEqual([{ id: 4, type: "doc.changed" }]);
    h.sse.close();
  });
});

const namedSourceOf = (): { source: SourceLike; fire: (event: MessageEventLike) => void } => {
  const listeners = new Map<string, (event: MessageEventLike) => void>();
  const source: SourceLike = {
    addEventListener: (type, listener) => {
      listeners.set(type, listener);
    },
    setOpen: () => undefined,
    setError: () => undefined,
    close: () => undefined,
  };
  return {
    source,
    fire: (event) => {
      listeners.get("doc.changed")?.(event);
    },
  };
};

describe("sse · 具名帧走事件名而不是 data.type", () => {
  it("should use the event name when it is not `message`", () => {
    const events: string[] = [];
    const fake = namedSourceOf();
    const sse = createSse(
      "/api/events",
      { open: () => fake.source, schedule: () => () => undefined, random: () => 0.5 },
      { onEvent: (event) => events.push(event.type), onState: () => undefined },
    );
    sse.start();
    fake.fire({ data: JSON.stringify({ changedNodes: [] }), lastEventId: "7" });
    sse.close();
    expect(events).toEqual(["doc.changed"]);
  });
});

describe("sse · message 帧缺 type 时退回约定的 message", () => {
  it("should fall back to `message` when a message frame has no type field", () => {
    const events: string[] = [];
    const listeners = new Map<string, (event: MessageEventLike) => void>();
    const source: SourceLike = {
      addEventListener: (type, listener) => {
        listeners.set(type, listener);
      },
      setOpen: () => undefined,
      setError: () => undefined,
      close: () => undefined,
    };
    const sse = createSse(
      "/api/events",
      { open: () => source, schedule: () => () => undefined, random: () => 0.5 },
      { onEvent: (event) => events.push(event.type), onState: () => undefined },
    );
    sse.start();
    listeners.get("message")?.({ data: JSON.stringify({ foo: 1 }), lastEventId: "5" });
    sse.close();
    expect(events).toEqual(["message"]);
  });
});
