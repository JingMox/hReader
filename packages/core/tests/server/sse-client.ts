// 这层管：SSE 测试连接——按空行切帧、事件驱动等待、deadline 诊断。
//
// 两个入口的分工：
// - `waitFor(n)`：**帧数确定**时用（例如只等首帧 `ready`）；它等的是"至少 n 帧"，不认事件名。
// - `waitForEvent(name)`：**等待某个事件**时用（例如 5xx 的 `error`），不要用帧数去等一个可能多帧的事件——
//   事件之外还会插 `doc.error` / `library.changed`，数帧会把非确定量绑进用例。
// 两者都靠 socket 的 `data` 事件驱动，等待上限是 `SSE_DEADLINE_MS`，超时由本模块抛出带帧清单的错误，
// 绝不把超时留给 vitest 的 `Test timed out`。
//
// 两个时钟，别混：
// - `SSE_DEADLINE_MS`（3000）= **等帧上限**：必须严格小于 vitest 默认的 5000ms，否则 vitest 会先报
//   `Test timed out`，帧清单出不来。
// - `SOCKET_LIFE_MS`（60_000）= **socket 寿命兜底**：最后手段，不是等待上限；它只保证连接不会永久挂着，
//   必须严格大于任何 per-test 预算（现为 30_000），否则用例被拖长时与 vitest 抢答；
//   `close()` 里 clear 掉，所以活过 3s 的连接不会被等帧 deadline 连带杀掉。
//   这个 clear 是否真的执行，由 `sse-v4.test.ts` 里 `vi.getTimerCount()` 的 delta 断言保证（本模块不自报计数）。
//
// `Date.now()` 仅用于诊断时间戳（订阅时刻、帧到达偏移），不参与断言（规范允许的例外）。

import { connect, type Socket } from "node:net";

/** SSE 等待上限：必须严格小于 vitest 默认的 5000ms，否则 vitest 会先报 `Test timed out`，harness 的帧清单就出不来。 */
export const SSE_DEADLINE_MS = 3000;

/** socket 寿命兜底：最后手段，与等帧上限解耦（`timeoutMs` 收到 3s 也不会把活着的连接 3s 就销毁）。
 * 必须严格大于任何 per-test 预算（当前最长 `30_000`），否则用例被拖长时两个时钟同值抢答。 */
const SOCKET_LIFE_MS = 60_000;

export interface SseFrame {
  readonly id: number | undefined;
  readonly event: string;
  readonly data: string;
}

/** `connectSse` 返回 socket 与 disarm 开关：兜底定时器用 `SOCKET_LIFE_MS`，`close()` 负责 clear，免得误伤。 */
const connectSse = (
  port: number,
  path: string,
  headers: Readonly<Record<string, string>>,
): { readonly socket: Socket; readonly disarm: () => void } => {
  const socket = connect({ host: "127.0.0.1", port });
  const destroyTimer = setTimeout(() => socket.destroy(), SOCKET_LIFE_MS);
  socket.setEncoding("utf8");
  const extra = Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}\r\n`)
    .join("");
  socket.write(
    `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nAccept: text/event-stream\r\n${extra}Connection: keep-alive\r\n\r\n`,
  );
  return {
    socket,
    disarm: () => {
      clearTimeout(destroyTimer);
    },
  };
};

/** 把缓冲区里所有完整帧吃掉，返回剩余的半帧（注释帧不是事件，不计数）；到达时刻另存在 `arrivals`。 */
const pumpSse = (input: string, frames: SseFrame[], arrivals: number[]): string => {
  let buffer = input;
  let end = buffer.indexOf("\n\n");
  while (end >= 0) {
    const block = buffer.slice(0, end);
    if (block.includes("data:")) {
      frames.push(frameOfRaw(block));
      arrivals.push(Date.now());
    }
    buffer = buffer.slice(end + 2);
    end = buffer.indexOf("\n\n");
  }
  return buffer;
};

/** 帧里没有 `event:` 头时，类型在 `data:` 的 JSON `type` 字段（见 event-ring.frameOf）。 */
const eventOf = (lines: readonly string[]): string => {
  const explicit = lines.find((line) => line.startsWith("event: "))?.slice(7);
  if (explicit !== undefined) return explicit;
  const data = lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "";
  return /"type":"([^"]+)"/u.exec(data)?.[1] ?? "message";
};

const frameOfRaw = (raw: string): SseFrame => {
  const lines = raw.split("\n");
  const idLine = lines.find((line) => line.startsWith("id: "));
  return {
    id: idLine === undefined ? undefined : Number(idLine.slice(4)),
    event: eventOf(lines),
    data: lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "",
  };
};

/** 超时文本：帧数、每帧 event 与到达偏移、订阅时刻、被等的 subject、以及"是不是换了个 event 名"的提示。 */
const describeTimeout = (input: {
  readonly frames: readonly SseFrame[];
  readonly arrivals: readonly number[];
  readonly subscriptionAt: number;
  readonly subject: string;
  readonly deadlineMs: number;
}): string => {
  const { frames, arrivals, subscriptionAt, subject, deadlineMs } = input;
  const head = `SSE 等待超时：${subject}未出现（deadline ${String(deadlineMs)}ms，订阅建立于 ${new Date(subscriptionAt).toISOString()}，已收到 ${String(frames.length)} 帧）`;
  const detail = frames.map((frame, index) => {
    const at = arrivals[index] ?? subscriptionAt;
    return `  #${String(index + 1)} +${String(at - subscriptionAt)}ms event=${frame.event} id=${frame.id === undefined ? "无" : String(frame.id)} data=${frame.data}`;
  });
  const seen = [...new Set(frames.map((frame) => frame.event))].map(
    (event) => `但曾收到 event=${event}`,
  );
  return [head, ...detail, ...seen].join("\n");
};

interface SseWaitContext {
  readonly frames: SseFrame[];
  readonly arrivals: number[];
  readonly subscriptionAt: number;
  readonly waiters: Set<() => void>;
  readonly isClosed: () => boolean;
  /** 关闭原因（`""` = 显式 `close()`）：断连时让 reject 文本带上"为什么"。 */
  readonly closeReason: () => string;
}

interface SseConnection {
  readonly frames: SseFrame[];
  readonly waitFor: (count: number) => Promise<SseFrame[]>;
  readonly waitForEvent: (event: string, deadlineMs?: number) => Promise<SseFrame>;
  readonly close: () => void;
}

/** deadline 到就 reject（带帧清单）；socket 有数据/关闭时由 `waiters` 叫醒重试。 */
const waitUntil = <T extends SseFrame | SseFrame[]>(
  context: SseWaitContext,
  accept: () => T | undefined,
  subject: string,
  deadlineMs: number,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const done = (): void => {
      clearTimeout(timer);
      context.waiters.delete(settle);
    };
    const settle = (): void => {
      const hit = accept();
      if (hit !== undefined) {
        done();
        resolve(hit);
        return;
      }
      if (context.isClosed()) {
        done();
        const reason = context.closeReason();
        const why = reason === "" ? "" : `（${reason}）`;
        reject(
          new Error(
            `连接已关闭${why}：${subject}未出现（已收到 ${String(context.frames.length)} 帧）`,
          ),
        );
      }
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error(describeTimeout({ ...context, subject, deadlineMs })));
    }, deadlineMs);
    context.waiters.add(settle);
    settle();
  });

/** 两个等待入口的构造：`waitFor` 看帧数，`waitForEvent` 看事件名。 */
const waitersOf = (
  context: SseWaitContext,
  timeoutMs: number,
): {
  readonly waitFor: (count: number) => Promise<SseFrame[]>;
  readonly waitForEvent: (event: string, deadlineMs?: number) => Promise<SseFrame>;
} => ({
  waitFor: (count) =>
    waitUntil(
      context,
      () => (context.frames.length >= count ? context.frames : undefined),
      `第 ${String(count)} 帧`,
      timeoutMs,
    ),
  waitForEvent: (event, deadlineMs = timeoutMs) =>
    waitUntil(
      context,
      () => context.frames.find((frame) => frame.event === event),
      `event=${event}`,
      deadlineMs,
    ),
});

interface SseHandlers {
  readonly onChunk: (chunk: string) => void;
  readonly shutdown: (reason: string) => void;
}

/** socket 的三个事件：数据喂帧；出错/断连都要自己说话，否则 waiter 要等满 deadline 才报"超时"，裸错误还会炸 worker。 */
const wireSse = (socket: Socket, handlers: SseHandlers): void => {
  socket.on("data", handlers.onChunk);
  socket.on("error", (error: Error) => {
    handlers.shutdown(`socket 错误：${error.message}`);
  });
  socket.on("close", () => {
    handlers.shutdown("socket 已关闭");
  });
};

interface SseLink extends SseHandlers {
  readonly frames: SseFrame[];
  readonly context: SseWaitContext;
}

/** 连接状态 + 关停：帧缓冲、waiter 表、关闭原因都只经这里改（`shutdown` 幂等：断开后的 `close` 事件直接返回）。 */
const createSseLink = (disarm: () => void): SseLink => {
  const frames: SseFrame[] = [];
  const arrivals: number[] = [];
  const subscriptionAt = Date.now();
  const waiters = new Set<() => void>();
  let buffer = "";
  let closed = false;
  let reason = "";
  const wake = (): void => {
    for (const waiter of [...waiters]) waiter();
  };
  const isClosed = (): boolean => closed;
  return {
    frames,
    context: {
      frames,
      arrivals,
      subscriptionAt,
      waiters,
      isClosed,
      closeReason: () => reason,
    },
    onChunk: (chunk: string) => {
      buffer = pumpSse(buffer + chunk, frames, arrivals);
      wake();
    },
    shutdown: (why: string) => {
      if (closed) return;
      closed = true;
      reason = why;
      disarm();
      wake();
    },
  };
};

/** 一条 SSE 连接：按空行切帧；`close()` 后不再收，且让在等的 waiter 立刻 reject。 */
export const openSse = (
  port: number,
  path: string,
  headers: Readonly<Record<string, string>> = {},
  timeoutMs = SSE_DEADLINE_MS,
): SseConnection => {
  const { socket, disarm } = connectSse(port, path, headers);
  const link = createSseLink(disarm);
  wireSse(socket, link);
  return {
    frames: link.frames,
    ...waitersOf(link.context, timeoutMs),
    close: () => {
      link.shutdown("");
      socket.destroy();
    },
  };
};
