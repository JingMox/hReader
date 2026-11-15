// 这层管：SSE/网络替身——按字节脚本喂流、按 URL 路由的 fetch、可挂起也可被 abort 打断的重连等待。
// 与 `fakes.ts`（Pi 注册面 / UI / 磁盘）分开只为让两个文件都短到能一眼读完。

import type { FetchLike, HreaderRequest } from "../pi-hreader.ts";

export const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

/** 字符下标 → 字节偏移：切多字节字时必须按字节给刀口。 */
export const byteOfIndex = (text: string, index: number): number =>
  bytesOf(text.slice(0, index)).length;

/** 按**字节**偏移切块：多字节 UTF-8 字被劈开的那一刀只能这么切。 */
export const chunksAt = (text: string, cuts: readonly number[]): readonly Uint8Array[] => {
  const bytes = bytesOf(text);
  const bounds = [0, ...cuts, bytes.length];
  return bounds.slice(1).map((end, index) => bytes.slice(bounds[index] ?? 0, end));
};

/** 刀口落在 `needle` **首字内部**：多字节保护只有这种切法能证明。 */
export const cutInsideCharOf = (text: string, needle: string): number => {
  const at = text.indexOf(needle);
  if (at === -1) throw new Error(`刀口找不到锚：${needle}`);
  return byteOfIndex(text, at) + 1;
};

export interface ScriptedReply {
  readonly status?: number;
  /** 一次性响应体（JSON 文本）；与 `chunks` 二选一。 */
  readonly text?: string;
  /** 流式响应体：逐块 enqueue，`keepOpen` 为假则 enqueue 完就 close。 */
  readonly chunks?: readonly (string | Uint8Array)[];
  /** 常驻流（SSE）：不 close，读到用例 `stop()` 时由 `cancel` 收尾。 */
  readonly keepOpen?: boolean;
  /** 流被 `cancel()`（停止读 / 订阅被 abort / 溢出弃帧）时回调：用来观测连接真被关掉。 */
  readonly onCancel?: () => void;
  /** `cancel()` 抛错：被 abort 的流上 cancel 会 reject，没人接住就会带崩进程。 */
  readonly cancelThrows?: boolean;
  /** 响应体拖多久才吐出来：构造“先发的慢响”（`/hr-style` 并发时的竞态）。 */
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

/** 队列耗尽后的"常驻空流"：让重连循环停在 `read()` 上，而不是空转。 */
const hungReplyOf = () => ({
  ok: true,
  status: 200,
  body: new ReadableStream<Uint8Array>(),
  text: () => Promise.resolve(""),
});

/** 按脚本依次给出响应；脚本用完就给常驻空流。 */
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

/** 按 URL 关键字路由的 fetch 替身：并发请求（事件流 + 拉批注 + 取文档）时不必猜调用顺序。 */
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
        // 队列留最后一个反复用：同一端点的第 N 次请求不必逐条排脚本。
        const next = queue.length > 1 ? queue.shift() : queue[0];
        return Promise.resolve(next === undefined ? hungReplyOf() : replyOf(next));
      }
      return Promise.resolve(hungReplyOf());
    },
    calls,
  };
};

/** 重连等待替身：一直挂着，直到 `stop()`（= signal abort）。测试不会空转。 */
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

/** 允许前 `steps` 次等待立刻返回，之后一直挂着：用来验证"断线→重连→带 Last-Event-ID"。 */
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

/** 让异步订阅循环往前走 `times` 个宏任务。 */
export const settleOf = (times = 8): Promise<void> =>
  times <= 0 ? Promise.resolve() : tickOf().then(() => settleOf(times - 1));

/** 调工具的简写：Pi 的 5 个位置参数里，测试只关心 `params` 与 `ctx`。 */
