// 这层管：SSE 事件环（单调 id + 容量裁剪 + `Last-Event-ID` 查找）与帧文本；不含 socket。

import type { SseEvent } from "./contracts";

export interface RingLookup {
  /** `false` = 断线期间的事件已被裁掉，客户端只能整页刷新。 */
  readonly hit: boolean;
  readonly events: readonly SseEvent[];
}

export interface EventRing {
  readonly push: (type: string, payload: Readonly<Record<string, unknown>>) => SseEvent;
  readonly since: (lastId: number) => RingLookup;
  readonly newest: () => number;
}

/**
 * `ready` 帧固定用 `id: 0`（不在环里）：客户端不传 `Last-Event-ID` 时从头开始，
 * 传 0 的客户端也能把环里的全部事件补回来。
 */
export const createEventRing = (capacity: number): EventRing => {
  const events: SseEvent[] = [];
  let newest = 0;
  return {
    push: (type, payload) => {
      newest += 1;
      const event: SseEvent = Object.freeze({
        id: newest,
        type,
        payload: Object.freeze({ ...payload }),
      });
      if (events.length === capacity) events.shift();
      events.push(event);
      return event;
    },
    since: (lastId) => {
      if (lastId >= newest) return { hit: true, events: Object.freeze([]) };
      const oldest = events[0];
      if (oldest === undefined) return { hit: true, events: Object.freeze([]) };
      if (lastId + 1 < oldest.id) return { hit: false, events: Object.freeze([]) };
      return { hit: true, events: Object.freeze(events.filter((event) => event.id > lastId)) };
    },
    newest: () => newest,
  };
};

/**
 * 帧头 token（`id:`/`event:`）的转义：先把 `\` 写成 `\\`，再把 CR/LF 折成 `-`。
 * 只折换行不转义反斜杠的话，字面量 `\n` 回放时会被读成真换行（帧头被裁断、`Last-Event-ID` 对不上）。
 */
export const frameTokenOf = (value: string, note?: (message: string) => void): string => {
  const escaped = value.replace(/\\/gu, "\\\\").replace(/[\r\n]/gu, "-");
  if (escaped !== value) note?.(`SSE 帧头含反斜杠/换行，已转义：${JSON.stringify(value)}`);
  return escaped;
};

/**
 * `data:` 行里的类型不值得转义反斜杠：那一层由 `JSON.stringify` 负责（它会把 `\` 保成 `\\`，解码回原值），
 * 这里只把真 CR/LF 折成 `-` 并记诊断——再预转义反斜杠反而会让类型在客户端变形。
 */
const foldTypeToken = (value: string, note?: (message: string) => void): string => {
  if (!/[\r\n]/u.test(value)) return value;
  note?.(`SSE 载荷 type 含换行，已折叠：${JSON.stringify(value)}`);
  return value.replace(/[\r\n]/gu, "-");
};

const typeOf = (payload: Readonly<Record<string, unknown>>): string => String(payload["type"]);

const payloadLine = (
  payload: Readonly<Record<string, unknown>>,
  note?: (m: string) => void,
): string => JSON.stringify({ ...payload, type: foldTypeToken(typeOf(payload), note) });

export const READY_FRAME = 'retry: 2000\nid: 0\ndata: {"type":"ready"}\n\n';

export const KEEP_ALIVE_FRAME = ": keep-alive\n\n";

/** 载荷里已有 `type` 时以它为准的写法会让"事件类型"有两个来源；这里只认事件自身的 `type`。 */
export const frameOf = (event: SseEvent, note?: (message: string) => void): string =>
  `id: ${frameTokenOf(String(event.id), note)}\ndata: ${payloadLine({ ...event.payload, type: event.type }, note)}\n\n`;

/** `reset` 没有环内 id（不是事件）：只发 data 行，仍走同一套转义。 */
export const resetFrameOf = (note?: (message: string) => void): string =>
  `data: ${payloadLine({ type: "reset", reason: "events_expired" }, note)}\n\n`;
