// 这层管：SSE 帧解码器的三类跨块切点与"哪些行不算帧"；帧字面量逐字抄自 core 的
// `packages/core/src/server/event-ring.ts`（AC-3 要求扩展侧独立拼写，由 AC-7 的钉子约束漂移）。

import { describe, expect, it } from "vitest";

import { createSseDecoder, type SseEnvelope } from "../pi-hreader.ts";
import { byteOfIndex, bytesOf, chunksAt, cutInsideCharOf } from "./sse-fakes.ts";

const READY = 'retry: 2000\nid: 0\ndata: {"type":"ready"}\n\n';
const CONNECT_COMMENT = ": ready\n\n";
const KEEP_ALIVE = ": keep-alive\n\n";
const RESET = 'data: {"type":"reset","reason":"events_expired"}\n\n';
const DOC_CHANGED = 'id: 7\ndata: {"path":"文档.html","type":"doc.changed"}\n\n';
const MIXED = CONNECT_COMMENT + KEEP_ALIVE + DOC_CHANGED + RESET;

const DOC_CHANGED_FRAME: SseEnvelope = {
  id: "7",
  data: '{"path":"文档.html","type":"doc.changed"}',
};
const RESET_FRAME: SseEnvelope = { data: '{"type":"reset","reason":"events_expired"}' };

/** utf-8 严格解码：遇到不完整的多字节序列直接抛错（“刀口真落在字内部”只能这么证）。 */
const strictDecodedOf = (bytes: Uint8Array): string =>
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);

describe("测试自己的刀口（`cutInsideCharOf` 不可自证就只是句声明）", () => {
  it("刀口落在多字节字内部，而字起点处切不报错——两条一起才能证明刀口的位置", () => {
    const text = DOC_CHANGED;
    const bytes = bytesOf(text);
    const inside = cutInsideCharOf(text, "文档");
    const atStart = byteOfIndex(text, text.indexOf("文档"));
    expect(inside).toBe(atStart + 1);
    expect(() => strictDecodedOf(bytes.slice(0, inside))).toThrow();
    expect(() => strictDecodedOf(bytes.slice(0, atStart))).not.toThrow();
    expect(() => strictDecodedOf(bytes.slice(0, atStart + 1))).toThrow();
  });
});

const drainOf = (chunks: readonly Uint8Array[]): readonly SseEnvelope[] => {
  const decoder = createSseDecoder();
  const frames = chunks.flatMap((chunk) => decoder.push(chunk));
  return [...frames, ...decoder.flush()];
};

/** 字符下标 → 落在第几个字节：多字节字被劈开的那一刀只能按字节给。 */
const cutAtCharOf = (text: string, needle: string, inNeedle: number): number =>
  byteOfIndex(text, text.indexOf(needle) + inNeedle);

describe("createSseDecoder 的帧边界", () => {
  it("注释帧（`: ready` / `: keep-alive`）不出帧，也不崩", () => {
    expect(drainOf([bytesOf(CONNECT_COMMENT + KEEP_ALIVE)])).toEqual([]);
  });

  it("一块里多帧：只交出有 data 的帧，顺序与到达顺序一致", () => {
    expect(drainOf([bytesOf(MIXED)])).toEqual([DOC_CHANGED_FRAME, RESET_FRAME]);
  });

  it("`data:` 行被腰斩在两块之间", () => {
    const cut = cutAtCharOf(DOC_CHANGED, "doc.changed", 4);
    expect(drainOf(chunksAt(DOC_CHANGED, [cut]))).toEqual([DOC_CHANGED_FRAME]);
  });

  it("终止符 `\\r\\n` 从中间分开（`\\r` 落在块尾）仍算一行", () => {
    const text = 'data: {"type":"doc.error","path":"a.html"}\r\n\r\n';
    const cut = byteOfIndex(text, text.indexOf("\r\n") + 1);
    expect(drainOf(chunksAt(text, [cut]))).toEqual([
      { data: '{"type":"doc.error","path":"a.html"}' },
    ]);
  });

  it("`\\r` 落在块尾时 `id:` 不得丢（等下一块再切，否则 Last-Event-ID 形同虚设）", () => {
    const text = 'id: 2\r\ndata: {"type":"doc.changed","path":"a.html"}\r\n\r\n';
    const decoder = createSseDecoder();
    const blocks = chunksAt(text, [byteOfIndex(text, text.indexOf("\r\n") + 1)]);
    expect(decoder.push(blocks[0] ?? bytesOf(""))).toEqual([]);
    expect(decoder.push(blocks[1] ?? bytesOf(""))).toEqual([
      { id: "2", data: '{"type":"doc.changed","path":"a.html"}' },
    ]);
  });

  it("多字节 UTF-8 字被块边界劈开时不出乱码", () => {
    // 刀口必须落在 `文` **字内部**：切在两个字之间只证明 data 行没断，证明不了流式解码。
    const frames = drainOf(chunksAt(DOC_CHANGED, [cutInsideCharOf(DOC_CHANGED, "文档")]));
    expect(frames).toEqual([DOC_CHANGED_FRAME]);
    expect(frames[0]?.data.includes("\uFFFD")).toBe(false);
  });
});

describe("createSseDecoder 的跨块累积", () => {
  it("一帧拆成逐字节的块，跨块累积仍是一帧", () => {
    const cuts = Array.from(
      { length: bytesOf(DOC_CHANGED).length - 1 },
      (_item, index) => index + 1,
    );
    expect(drainOf(chunksAt(DOC_CHANGED, cuts))).toEqual([DOC_CHANGED_FRAME]);
  });

  it("流结束时末帧缺空行终止符，由 flush 交出；再 flush 不再重复", () => {
    const decoder = createSseDecoder();
    expect(decoder.push(bytesOf('data: {"type":"ready"}'))).toEqual([]);
    expect(decoder.flush()).toEqual([{ data: '{"type":"ready"}' }]);
    expect(decoder.flush()).toEqual([]);
  });
});

describe("createSseDecoder 的字段口径", () => {
  it("`ready` 带 `retry:` 与 `id: 0`：retry 不进 data，id 原样交给订阅层判定", () => {
    expect(drainOf([bytesOf(READY)])).toEqual([{ id: "0", data: '{"type":"ready"}' }]);
  });

  it("`reset` 帧没有 `id:` 字段", () => {
    const [frame] = drainOf([bytesOf(RESET)]);
    expect(frame).toEqual(RESET_FRAME);
    expect(frame !== undefined && "id" in frame).toBe(false);
  });

  it("同一帧多条 `data:` 行按换行拼接", () => {
    expect(drainOf([bytesOf("data: a\ndata: b\n\n")])).toEqual([{ data: "a\nb" }]);
  });

  it("字段名后没有冒号时按空值处理，不崩", () => {
    expect(drainOf([bytesOf("data\ndata: x\n\n")])).toEqual([{ data: "\nx" }]);
  });

  it("只有 `id:` 没有 `data:` 的空帧被丢弃", () => {
    expect(drainOf([bytesOf("id: 5\n\n")])).toEqual([]);
  });

  it("`\\r` 单独作行终止符（老式换行）也能切帧", () => {
    expect(drainOf([bytesOf('data: {"type":"library.changed"}\r\r')])).toEqual([
      { data: '{"type":"library.changed"}' },
    ]);
  });

  it("无换行的巨型响应体不算帧：超限后置 overflowed，且不交半截帧", () => {
    const decoder = createSseDecoder(16);
    expect(decoder.overflowed()).toBe(false);
    expect(decoder.push(bytesOf("data: {"))).toEqual([]);
    expect(decoder.push(bytesOf("x".repeat(64)))).toEqual([]);
    expect(decoder.overflowed()).toBe(true);
    expect(decoder.flush()).toEqual([]);
  });
});
