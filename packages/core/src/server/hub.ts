// 这层管：SSE 客户端表 + 心跳 + `Last-Event-ID` 补齐编排；事件环与帧格式在 `event-ring.ts`。

import type { ServerResponse } from "node:http";

import { HrError } from "../hr-error";
import type { SseEvent } from "./contracts";
import {
  createEventRing,
  frameOf,
  KEEP_ALIVE_FRAME,
  READY_FRAME,
  resetFrameOf,
  type EventRing,
} from "./event-ring";

const HEARTBEAT_MS = 30_000;
/** 首帧先发注释：代理/浏览器在第一个字节就能确认"流已建立"，不必等到第一个事件。 */
export const CONNECT_COMMENT = ": ready\n\n";
/** 客户端表满时告诉对方多久再试：只关连接不带重试间隔会让客户端立刻重连，把表打得更满。 */
export const RETRY_AFTER_MS = 2_000;
export const MAX_CLIENTS = 64;

export interface Hub {
  readonly addClient: (res: ServerResponse, lastEventId: string | undefined) => number;
  readonly removeClient: (id: number) => void;
  readonly publish: (type: string, payload: Readonly<Record<string, unknown>>) => SseEvent;
  readonly clientCount: number;
  readonly ring: EventRing;
  readonly close: () => void;
}

interface HubInput {
  readonly ring: EventRing;
  readonly heartbeatMs?: number;
  /** 帧头被替换/裁剪时的诊断出口；默认丢弃。 */
  readonly diagnose?: (message: string) => void;
}

const lastIdOf = (raw: string): number => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return 0;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 0) return 0;
  return value;
};

/** 先写头再 flush：不 flush 的话代理会攒着直到第一个事件，客户端看不到 `ready`。 */
const openStream = (res: ServerResponse): void => {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "x-accel-buffering": "no",
    "x-content-type-options": "nosniff",
  });
  res.flushHeaders();
  res.write(CONNECT_COMMENT);
  res.write(READY_FRAME);
};

/** 断线期间被裁掉时先发 `reset`，再按环里的全部事件补（少了就是"客户端要整页刷新"）。 */
/** 只有显式带 `Last-Event-ID` 才补发：新连接回放整环会把进程启动期的旧事件当成"刚发生"。 */
const backfill = (
  res: ServerResponse,
  ring: EventRing,
  lastEventId: string | undefined,
  note: ((message: string) => void) | undefined,
): void => {
  if (lastEventId === undefined) return;
  const lookup = ring.since(lastIdOf(lastEventId));
  if (!lookup.hit) res.write(resetFrameOf(note));
  for (const event of lookup.events) res.write(frameOf(event, note));
};

interface ClientTable {
  readonly map: Map<number, ServerResponse>;
  readonly take: () => number;
}

const addClientOf =
  (input: HubInput, table: ClientTable): Hub["addClient"] =>
  (res, lastEventId) => {
    if (table.map.size >= MAX_CLIENTS) {
      // 429 必须自己关连接：交给上层 `res.end()` 时 body 可能还没刷出去（客户端看到的是空 429）。
      res.writeHead(429, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        connection: "close",
        "retry-after": String(RETRY_AFTER_MS / 1_000),
      });
      res.end(
        JSON.stringify({
          code: "too_many_clients",
          message: `SSE 客户端已满（上限 ${String(MAX_CLIENTS)}）`,
          retryAfterMs: RETRY_AFTER_MS,
        }),
      );
      throw new HrError("too_many_clients", `SSE 客户端已满（上限 ${String(MAX_CLIENTS)}）`);
    }
    openStream(res);
    backfill(res, input.ring, lastEventId, input.diagnose);
    const id = table.take();
    table.map.set(id, res);
    res.on("close", () => {
      table.map.delete(id);
    });
    return id;
  };

export const createHub = (input: HubInput): Hub => {
  const map = new Map<number, ServerResponse>();
  let next = 1;
  const table: ClientTable = {
    map,
    take: () => {
      const id = next;
      next += 1;
      return id;
    },
  };
  const heartbeat = setInterval(() => {
    for (const res of map.values()) res.write(KEEP_ALIVE_FRAME);
  }, input.heartbeatMs ?? HEARTBEAT_MS);
  heartbeat.unref();
  return {
    addClient: addClientOf(input, table),
    removeClient: (id) => {
      map.delete(id);
    },
    publish: (type, payload) => {
      const event = input.ring.push(type, payload);
      for (const res of map.values()) res.write(frameOf(event, input.diagnose));
      return event;
    },
    get clientCount() {
      return map.size;
    },
    ring: input.ring,
    close: () => {
      clearInterval(heartbeat);
      for (const res of map.values()) res.end();
      map.clear();
    },
  };
};

export const createServerHub = (diagnose?: (message: string) => void): Hub =>
  createHub({ ring: createEventRing(256), ...(diagnose === undefined ? {} : { diagnose }) });
