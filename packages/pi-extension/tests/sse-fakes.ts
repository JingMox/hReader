// SSE/network doubles: scripted-byte stream feeds, a URL-routed fetch, and a reconnect wait that can hang
// or be interrupted by abort. Kept apart from `fakes.ts` (Pi surface / UI / disk) only so both files stay short.

import type { FetchLike, HreaderRequest } from "../pi-hreader.ts";

export const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Char index → byte offset: multi-byte chars can only be cut by byte. */
export const byteOfIndex = (text: string, index: number): number =>
  bytesOf(text.slice(0, index)).length;

/** Splits by **byte** offset — the only way to slice a multi-byte UTF-8 char in half. */
export const chunksAt = (text: string, cuts: readonly number[]): readonly Uint8Array[] => {
  const bytes = bytesOf(text);
  const bounds = [0, ...cuts, bytes.length];
  return bounds.slice(1).map((end, index) => bytes.slice(bounds[index] ?? 0, end));
};

/** The cut lands **inside `needle`'s first char** — the only split that proves multi-byte protection. */
export const cutInsideCharOf = (text: string, needle: string): number => {
  const at = text.indexOf(needle);
  if (at === -1) throw new Error(`刀口找不到锚：${needle}`);
  return byteOfIndex(text, at) + 1;
};

export interface ScriptedReply {
  readonly status?: number;
  /** One-shot response body (JSON text); pick this or `chunks`. */
  readonly text?: string;
  /** Streaming response body: enqueued chunk by chunk, closed after the last unless `keepOpen`. */
  readonly chunks?: readonly (string | Uint8Array)[];
  /** Resident stream (SSE): never closes; `cancel` winds it down when the case calls `stop()`. */
  readonly keepOpen?: boolean;
  /** Callback when the stream is `cancel()`ed (read stopped / subscription aborted / frame dropped on overflow): proves the connection really closed. */
  readonly onCancel?: () => void;
  /** `cancel()` throws: cancel on an aborted stream rejects, and an uncaught rejection crashes the process. */
  readonly cancelThrows?: boolean;
  /** How long the response body takes to arrive: builds "the earlier slow reply" (the `/hr-style` concurrency race). */
  readonly waitMs?: number;
}

const bodyOf = (reply: ScriptedReply): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start: (controller) => {
      for (const chunk of reply.chunks ?? []) {
        controller.enqueue(typeof chunk === "string" ? bytesOf(chunk) : chunk);
      }
      if (reply.keepOpen !== true) controller.close();
    },
    cancel: () => {
      reply.onCancel?.();
      if (reply.cancelThrows === true) throw new Error("底层 cancel 失败");
    },
  });

const replyOf = (reply: ScriptedReply) => {
  const status = reply.status ?? 200;
  return {
    ok: status < 400,
    status,
    body: reply.chunks === undefined ? null : bodyOf(reply),
    text: () =>
      reply.waitMs === undefined
        ? Promise.resolve(reply.text ?? "")
        : new Promise<string>((done) => {
            setTimeout(() => {
              done(reply.text ?? "");
            }, reply.waitMs);
          }),
  };
};

/** The "resident empty stream" after the queue runs out: parks the reconnect loop inside `read()` instead of spinning. */
const hungReplyOf = () => ({
  ok: true,
  status: 200,
  body: new ReadableStream<Uint8Array>(),
  text: () => Promise.resolve(""),
});

/** Answers responses in script order; hands out the resident empty stream once the script is spent. */
export const scriptedFetchOf = (
  replies: readonly ScriptedReply[],
): {
  readonly fetch: FetchLike;
  readonly calls: readonly { url: string; request: HreaderRequest }[];
} => {
  const queue = [...replies];
  const calls: { url: string; request: HreaderRequest }[] = [];
  return {
    fetch: (url, request) => {
      calls.push({ url, request });
      const next = queue.shift();
      return Promise.resolve(next === undefined ? hungReplyOf() : replyOf(next));
    },
    calls,
  };
};

/** A fetch double routed by URL keyword: no need to guess call order when requests run concurrently (event stream + annotation fetch + document fetch). */
export const routedFetchOf = (
  routes: Readonly<Record<string, readonly ScriptedReply[]>>,
): {
  readonly fetch: FetchLike;
  readonly calls: readonly { url: string; request: HreaderRequest }[];
} => {
  const queues = new Map(Object.entries(routes).map(([key, replies]) => [key, [...replies]]));
  const calls: { url: string; request: HreaderRequest }[] = [];
  return {
    fetch: (url, request) => {
      calls.push({ url, request });
      for (const [key, queue] of queues) {
        if (!url.includes(key)) continue;
        // The last queue entry is reused forever: the Nth request to one endpoint needs no per-call script.
        const next = queue.length > 1 ? queue.shift() : queue[0];
        return Promise.resolve(next === undefined ? hungReplyOf() : replyOf(next));
      }
      return Promise.resolve(hungReplyOf());
    },
    calls,
  };
};

/** Reconnect-wait double: stays pending until `stop()` (= signal abort). Tests never spin. */
export const holdDelayOf =
  () =>
  (_ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((done) => {
      if (signal.aborted) {
        done();
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          done();
        },
        { once: true },
      );
    });

/** Lets the first `steps` waits resolve immediately, then stays pending: proves "disconnect → reconnect → with Last-Event-ID". */
export const steppedDelayOf = (steps: number) => {
  let left = steps;
  return (_ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((done) => {
      if (signal.aborted) {
        done();
        return;
      }
      if (left > 0) {
        left -= 1;
        done();
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          done();
        },
        { once: true },
      );
    });
};

const tickOf = (): Promise<void> =>
  new Promise((done) => {
    setImmediate(done);
  });

/** Advances the async subscription loop by `times` macrotasks. */
export const settleOf = (times = 8): Promise<void> =>
  times <= 0 ? Promise.resolve() : tickOf().then(() => settleOf(times - 1));

/** Shorthand for invoking a tool: of Pi's 5 positional args only `params` and `ctx` matter to tests. */
