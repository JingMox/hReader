// This layer covers the thumbnail render queue's contract on an instrumented
// fake `work`: one run in flight, FIFO drain order, same-key single-flight,
// failure propagation, and "a rejection leaves the queue usable".

import { describe, expect, it } from "vitest";

import { createRenderQueue } from "../src/thumbs/queue";

/** A manually-gated work item: `start` fires when the queue runs it, `release` settles it. */
interface Gate {
  readonly work: () => Promise<string>;
  readonly started: Promise<void>;
  readonly release: (value: string | Error) => void;
}

const gateOf = (): Gate => {
  let resolveStarted!: () => void;
  let settle!: (value: string | Error) => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const work = (): Promise<string> => {
    resolveStarted();
    return new Promise<string>((resolve, reject) => {
      settle = (value) => {
        if (value instanceof Error) reject(value);
        else resolve(value);
      };
    });
  };
  // A stable delegate: `settle` only exists once `work` runs, so callers must `await started` first.
  const release: Gate["release"] = (value) => {
    settle(value);
  };
  return { work, started, release };
};

/** Let already-queued microtasks (the queue's drain loop) run before sampling. */
const tick = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("thumbs/queue · single-flight", () => {
  it("should share one run between concurrent same-key submissions", async () => {
    const queue = createRenderQueue();
    let runs = 0;
    const gate = gateOf();
    const work = async (): Promise<string> => {
      runs += 1;
      return await gate.work();
    };

    const first = queue.submit("doc:hash", work);
    const second = queue.submit("doc:hash", work);
    await gate.started;
    gate.release("png");

    await expect(first).resolves.toBe("png");
    await expect(second).resolves.toBe("png");
    expect(runs).toBe(1);
  });

  it("should start a fresh run for a key re-submitted after settle", async () => {
    const queue = createRenderQueue();
    let runs = 0;
    const work = async (): Promise<number> => {
      runs += 1;
      return await Promise.resolve(runs);
    };

    await expect(queue.submit("doc:hash", work)).resolves.toBe(1);
    await expect(queue.submit("doc:hash", work)).resolves.toBe(2);
    expect(runs).toBe(2);
  });
});

describe("thumbs/queue · concurrency bound", () => {
  it("should never run two works concurrently, even across different keys", async () => {
    const queue = createRenderQueue();
    let active = 0;
    let peak = 0;
    const gates = [gateOf(), gateOf(), gateOf()];
    const workOf = (gate: Gate) => async (): Promise<string> => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        return await gate.work();
      } finally {
        active -= 1;
      }
    };

    const results = [
      queue.submit("a", workOf(gates[0] ?? gateOf())),
      queue.submit("b", workOf(gates[1] ?? gateOf())),
      queue.submit("c", workOf(gates[2] ?? gateOf())),
    ];
    for (const [index, gate] of gates.entries()) {
      await gate.started;
      gate.release(`r${String(index)}`);
    }

    await expect(Promise.all(results)).resolves.toEqual(["r0", "r1", "r2"]);
    expect(peak).toBe(1);
  });
});

describe("thumbs/queue · FIFO", () => {
  it("should start pending works in submission order", async () => {
    const queue = createRenderQueue();
    const order: string[] = [];
    const gates = [gateOf(), gateOf(), gateOf()];
    const workOf = (key: string, gate: Gate) => async (): Promise<string> => {
      order.push(key);
      return await gate.work();
    };

    const results = [
      queue.submit("first", workOf("first", gates[0] ?? gateOf())),
      queue.submit("second", workOf("second", gates[1] ?? gateOf())),
      queue.submit("third", workOf("third", gates[2] ?? gateOf())),
    ];
    for (const gate of gates) {
      await gate.started;
      gate.release("done");
    }

    await Promise.all(results);
    expect(order).toEqual(["first", "second", "third"]);
  });
});

describe("thumbs/queue · failure", () => {
  it("should propagate the work's rejection to every sharer", async () => {
    const queue = createRenderQueue();
    const gate = gateOf();
    const first = queue.submit("doc:hash", gate.work);
    const second = queue.submit("doc:hash", gate.work);
    await gate.started;
    gate.release(new Error("render_timeout: boom"));

    await expect(first).rejects.toThrow("render_timeout: boom");
    await expect(second).rejects.toThrow("render_timeout: boom");
  });

  it("should leave the queue usable after a failed run (timeout recovery)", async () => {
    const queue = createRenderQueue();
    const bad = gateOf();
    const good = gateOf();
    const failed = queue.submit("k1", bad.work);
    const next = queue.submit("k2", good.work);
    await bad.started;
    bad.release(new Error("timeout"));

    await expect(failed).rejects.toThrow("timeout");
    await good.started;
    good.release("alive");
    await expect(next).resolves.toBe("alive");

    // Same key again after its failure: a fresh run, not a poisoned entry.
    const again = gateOf();
    const rerun = queue.submit("k1", again.work);
    await again.started;
    again.release("recovered");
    await expect(rerun).resolves.toBe("recovered");
  });

  it("should propagate a synchronous throw as a rejection and keep draining", async () => {
    const queue = createRenderQueue();
    const good = gateOf();
    const failed = queue.submit("sync-throw", () => {
      throw new Error("sync boom");
    });
    const next = queue.submit("after", good.work);

    await expect(failed).rejects.toThrow("sync boom");
    await good.started;
    good.release("ok");
    await expect(next).resolves.toBe("ok");
    await tick();
  });
});
