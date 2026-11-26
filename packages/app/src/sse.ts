// 这层管：SSE 连接的生命周期——指数退避（1s 起 ×2、上限 30s、±20% 抖动）、重连重置、
// "旧 revision 丢弃"，以及具名事件（`doc.changed`/`library.changed`）。
// `EventSource` 可注入，纯逻辑全部在回调里。

import { isRecord, stringOf } from "./guard.ts";
import type { ConnState } from "./state.ts";

export interface MessageEventLike {
  readonly data: string;
  /** 帧头 `id:`：浏览器总会给（没有 `id:` 时是空串）；测试构造的事件可能省略。 */
  readonly lastEventId?: string;
}

export interface SourceLike {
  readonly addEventListener: (type: string, listener: (event: MessageEventLike) => void) => void;
  readonly close: () => void;
  readonly setOpen: (listener: () => void) => void;
  readonly setError: (listener: () => void) => void;
}

export interface SseEvent {
  readonly id: number;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** 服务端会用的具名事件；`message` 作为兜底（无 `event:` 行的实现）。 */
const NAMED = ["doc.changed", "doc.reloaded", "library.changed"] as const;

interface SseDeps {
  readonly open: (url: string) => SourceLike;
  readonly schedule: (ms: number, run: () => void) => () => void;
  readonly random: () => number;
}

export interface SseHandlers {
  readonly onEvent: (event: SseEvent) => void;
  readonly onState: (state: ConnState) => void;
}

export interface Sse {
  readonly start: () => void;
  readonly close: () => void;
}

const BASE_MS = 1_000;
const CAP_MS = 30_000;
const JITTER = 0.2;

const backoffOf = (attempt: number, random: () => number): number => {
  const raw = Math.min(CAP_MS, BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(raw * (1 - JITTER + random() * JITTER * 2));
};

/** 帧头 id 是十进制字符串；`>=` 让重放/乱序的旧帧被丢弃（`""` 视为 0，即"还没见过任何帧"）。 */
const isStale = (lastEventId: string, id: number): boolean => Number(lastEventId) >= id;

/** 载荷只取 `payload` 一层的浅拷贝；`id`/`type` 以帧为准。 */
const payloadOf = (raw: string): Readonly<Record<string, unknown>> | undefined => {
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) ? { ...value } : undefined;
  } catch {
    return undefined;
  }
};

interface Ctl {
  source: SourceLike | undefined;
  cancel: (() => void) | undefined;
  attempt: number;
  closed: boolean;
  /** 上一帧的帧头 `id:`（字符串原值）：`0` 与 `""` 是不同状态，不能压成数字。 */
  lastEventId: string;
}

const deliverOf =
  (ctl: Ctl, handlers: SseHandlers, named: string) =>
  (event: MessageEventLike): void => {
    const frameId = event.lastEventId ?? "";
    const id = Number(frameId);
    const body = payloadOf(event.data);
    if (body === undefined) return;
    if (Number.isNaN(id)) return;
    if (isStale(ctl.lastEventId, id)) return;
    ctl.lastEventId = frameId;
    handlers.onEvent({
      id,
      type: named === "message" ? (stringOf(body["type"]) ?? named) : named,
      payload: body,
    });
  };

const connectOf = (ctl: Ctl, url: string, deps: SseDeps, handlers: SseHandlers): (() => void) => {
  return () => {
    const opened = deps.open(url);
    ctl.source = opened;
    opened.setOpen(() => {
      ctl.attempt = 0;
      ctl.cancel?.(); // 重连成功：清掉待触发的退避定时器
      ctl.cancel = undefined;
      handlers.onState("live");
    });
    opened.setError(() => {
      opened.close();
      if (ctl.closed) return;
      ctl.attempt += 1;
      handlers.onState("reconnecting");
      ctl.cancel?.(); // 不叠加定时器：先撤旧的再设新的
      ctl.cancel = deps.schedule(backoffOf(ctl.attempt, deps.random), () => {
        if (!ctl.closed) connectOf(ctl, url, deps, handlers)();
      });
    });
    opened.addEventListener("message", deliverOf(ctl, handlers, "message"));
    for (const named of NAMED) {
      opened.addEventListener(named, deliverOf(ctl, handlers, named));
    }
  };
};

export const createSse = (url: string, deps: SseDeps, handlers: SseHandlers): Sse => {
  const ctl: Ctl = {
    source: undefined,
    cancel: undefined,
    attempt: 0,
    closed: false,
    lastEventId: "",
  };

  return {
    start: () => {
      ctl.closed = false;
      handlers.onState("connecting");
      connectOf(ctl, url, deps, handlers)();
    },
    close: () => {
      ctl.closed = true;
      ctl.cancel?.();
      ctl.cancel = undefined;
      ctl.source?.close();
      handlers.onState("offline");
    },
  };
};
