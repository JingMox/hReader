// The `/api/events` subscription: auth headers, `Last-Event-ID` (where `id: 0` must not enter the cache),
// `reset` staleness handling, reconnect after drops, and `stop()` really stopping (Pi must not hang on exit).

import { describe, expect, it } from "vitest";

import { delayOf, subscribeOf, type DaemonInfo, type HreaderEvent } from "../pi-hreader.ts";
import { daemonJsonOf, fakeDepsOf } from "./fakes.ts";
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

/** Counts `cancel` on the scripted reply: whether `cancel()` really lands on the body can only be observed this way. */
const cancellingOf = (reply: ScriptedReply, counter: Counter): ScriptedReply => ({
  ...reply,
  onCancel: () => {
    counter.count += 1;
  },
});

/** Runs a stretch while listening for unhandled rejections and returns the reasons heard (the listener is always removed). */
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

describe("subscribeOf connection and authentication", () => {
  it("should connect to `/api/events` with `Cookie: hr=<token>` (the cookie value is the daemon token)", async () => {
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

  it("should send no CSRF header on the first connect (a read endpoint takes no `x-hr-csrf`)", async () => {
    const { calls, subscription } = await driveOf([{ chunks: [READY], keepOpen: true }]);
    subscription.stop();
    expect(calls[0]?.request.headers["x-hr-csrf"]).toBeUndefined();
  });
});

describe("subscribeOf frame routing", () => {
  it("should route a `reset` frame to the staleness notice, not to business events (it must not be swallowed as unknown)", async () => {
    const { events, stales, subscription } = await driveOf([{ chunks: [RESET], keepOpen: true }]);
    subscription.stop();
    expect(stales).toHaveLength(1);
    expect(events).toEqual([]);
  });

  it("should ignore types outside the four business types without reporting them as bad frames (`applause` vs bad frame must differ)", async () => {
    const { bads, events, subscription } = await driveOf([
      { chunks: [READY + UNKNOWN], keepOpen: true },
    ]);
    subscription.stop();
    expect(events).toEqual([]);
    expect(bads).toEqual([]);
  });

  it("should pass `id:` verbatim to the caller (a `Last-Event-ID` candidate)", async () => {
    const { events, subscription } = await driveOf([{ chunks: [DOC_CHANGED], keepOpen: true }]);
    subscription.stop();
    expect(events[0]?.id).toBe("7");
    expect(events[0]?.payload["docId"]).toBe("docs/a.html");
  });
});

describe("subscribeOf reconnects", () => {
  it("should reconnect with `Last-Event-ID` after the stream drops", async () => {
    const { calls, downs, subscription } = await driveOf(
      [{ chunks: [DOC_CHANGED] }, { chunks: [], keepOpen: true }],
      { delay: steppedDelayOf(1) },
    );
    subscription.stop();
    expect(downs).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.request.headers["last-event-id"]).toBe("7");
  });

  it("should not take `ready`'s `id: 0` as `Last-Event-ID` (it is not in the ring)", async () => {
    const { calls, subscription } = await driveOf(
      [{ chunks: [READY] }, { chunks: [], keepOpen: true }],
      { delay: steppedDelayOf(1) },
    );
    subscription.stop();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.request.headers["last-event-id"]).toBeUndefined();
  });

  it("should treat a non-2xx HTTP status as a drop and reconnect", async () => {
    const { calls, downs, subscription } = await driveOf(
      [{ status: 401 }, { chunks: [], keepOpen: true }],
      { delay: steppedDelayOf(1) },
    );
    subscription.stop();
    expect(downs).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("should re-read daemon.json in the down window and reconnect to the new address when a daemon restart changes port/token", async () => {
    // The old info froze at subscribeOf; daemon.json has been rewritten by the new process to :7332/tok-2.
    // Without the re-read the second connect would hit :7331 with tok-1 forever 401 — this is that incident's regression.
    const readFile = (file: string): Promise<Uint8Array> =>
      file === "/home/.hreader/daemon.json"
        ? Promise.resolve(new TextEncoder().encode(daemonJsonOf({ port: 7332, token: "tok-2" })))
        : Promise.reject(new Error(`ENOENT: ${file}`));
    const script = scriptedFetchOf([
      { chunks: [DOC_CHANGED] }, // receives id=7, then drops: the old cursor is invalid on the **new** ring
      { chunks: [], keepOpen: true },
    ]);
    const subscription = subscribeOf(
      { home: "/home", readFile, fetch: script.fetch, delay: steppedDelayOf(1) },
      INFO,
      {
        onEvent: () => undefined,
        onStale: () => undefined,
        onDown: () => undefined,
        onBadFrame: () => undefined,
      },
    );
    await settleOf();
    subscription.stop();
    expect(script.calls.at(-1)?.url).toBe("http://127.0.0.1:7332/api/events");
    expect(script.calls.at(-1)?.request.headers["cookie"]).toBe("hr=tok-2");
    expect(script.calls.at(-1)?.request.headers["last-event-id"]).toBeUndefined();
  });

  it("should keep the old info and `Last-Event-ID` cursor when daemon.json is unchanged (same port+token)", async () => {
    const readFile = (): Promise<Uint8Array> =>
      Promise.resolve(new TextEncoder().encode(daemonJsonOf({ port: 7331, token: "tok-1" })));
    const script = scriptedFetchOf([{ chunks: [DOC_CHANGED] }, { chunks: [], keepOpen: true }]);
    const subscription = subscribeOf(
      { home: "/home", readFile, fetch: script.fetch, delay: steppedDelayOf(1) },
      INFO,
      {
        onEvent: () => undefined,
        onStale: () => undefined,
        onDown: () => undefined,
        onBadFrame: () => undefined,
      },
    );
    await settleOf();
    subscription.stop();
    expect(script.calls.at(-1)?.url).toBe("http://127.0.0.1:7331/api/events");
    expect(script.calls.at(-1)?.request.headers["last-event-id"]).toBe("7");
  });
});

describe("subscribeOf errors and dropped frames", () => {
  it("should not throw at Pi when `fetch` rejects (daemon exited); it only reconnects", async () => {
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

  it("should drop a frame whose `data` is not JSON-with-type but report the raw text (protocol drift must not be swallowed silently)", async () => {
    const { bads, events, subscription } = await driveOf([
      { chunks: [`data: 不是 JSON\n\ndata: {"no":"type"}\n\n${UNKNOWN}`] },
    ]);
    subscription.stop();
    expect(events).toEqual([]);
    // Both leading frames are bad, but one subscription reports only one (throttling); the raw text must surface verbatim.
    expect(bads).toEqual(["不是 JSON"]);
  });
});

describe("bad-frame detection and throttling", () => {
  it("should judge junk frames individually: non-JSON / no type / non-object each report once; unknown-type JSON does not", async () => {
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

  it("should throttle bad-frame reports: 50 bad frames yield one report (a hint per frame would flood forever)", async () => {
    const frames = Array.from({ length: 50 }, () => "data: 不是 JSON\n\n");
    const { bads, subscription } = await driveOf([{ chunks: [frames.join("")] }]);
    subscription.stop();
    expect(bads).toHaveLength(1);
  });

  it("should allow one more report after a healthy stream post-reconnect (the throttle is not a one-shot gate)", async () => {
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

describe("stream teardown (connections must not leak)", () => {
  it("should close the body even on overflow drop: cancel exactly once (not only via the abort path)", async () => {
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

  it("should not double-close via abort plus finally: one cancel per reader", async () => {
    const counter: Counter = { count: 0 };
    const { subscription } = await driveOf([
      cancellingOf({ chunks: [DOC_CHANGED], keepOpen: true }, counter),
    ]);
    subscription.stop();
    await settleOf(4);
    expect(counter.count).toBe(1);
  });

  it("should not let a `cancel()` throw become an unhandled rejection (Node 24 crashes by default)", async () => {
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

describe("subscribeOf teardown", () => {
  it("should interrupt the read on `stop()`: no reconnect, no onDown", async () => {
    const { calls, downs, subscription } = await driveOf([
      { chunks: [DOC_CHANGED], keepOpen: true },
    ]);
    subscription.stop();
    await settleOf(4);
    expect(calls).toHaveLength(1);
    expect(downs).toEqual([]);
  });

  it("should let abort interrupt the reconnect wait: no timer keeps the process after `stop()`", async () => {
    const controller = new AbortController();
    const waiting = delayOf(60_000, controller.signal);
    controller.abort();
    await expect(waiting).resolves.toBeUndefined();
  });

  it("should finish the reconnect wait on time and return at once when signal is already aborted", async () => {
    const alive = new AbortController();
    await expect(delayOf(1, alive.signal)).resolves.toBeUndefined();
    alive.abort();
    await expect(delayOf(60_000, alive.signal)).resolves.toBeUndefined();
  });
});
