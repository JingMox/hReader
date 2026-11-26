// The SSE frame decoder's three cross-chunk cut points and "which lines do not make a frame"; frame
// literals are copied verbatim from core's `packages/core/src/server/event-ring.ts` (the extension
// re-spells them, drift held by the protocol-pins).

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

/** Strict utf-8 decode: throws on an incomplete multi-byte sequence (the only way to prove "the cut lands inside a char"). */
const strictDecodedOf = (bytes: Uint8Array): string =>
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);

describe("the test's own blade (`cutInsideCharOf` is just a claim unless proven)", () => {
  it("should cut inside a multi-byte char while a cut at the char start stays clean — both together prove the blade's position", () => {
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

/** Char index → which byte it lands on: the cut that splits a multi-byte char can only be given by byte. */
const cutAtCharOf = (text: string, needle: string, inNeedle: number): number =>
  byteOfIndex(text, text.indexOf(needle) + inNeedle);

describe("createSseDecoder frame boundaries", () => {
  it("should neither emit a frame nor crash on comment frames (`: ready` / `: keep-alive`)", () => {
    expect(drainOf([bytesOf(CONNECT_COMMENT + KEEP_ALIVE)])).toEqual([]);
  });

  it("should yield only frames with data, in arrival order, when one chunk holds several", () => {
    expect(drainOf([bytesOf(MIXED)])).toEqual([DOC_CHANGED_FRAME, RESET_FRAME]);
  });

  it("should survive a `data:` line split across two chunks", () => {
    const cut = cutAtCharOf(DOC_CHANGED, "doc.changed", 4);
    expect(drainOf(chunksAt(DOC_CHANGED, [cut]))).toEqual([DOC_CHANGED_FRAME]);
  });

  it("should still count a `\\r\\n` split mid-terminator (`\\r` at the chunk end) as one line", () => {
    const text = 'data: {"type":"doc.error","path":"a.html"}\r\n\r\n';
    const cut = byteOfIndex(text, text.indexOf("\r\n") + 1);
    expect(drainOf(chunksAt(text, [cut]))).toEqual([
      { data: '{"type":"doc.error","path":"a.html"}' },
    ]);
  });

  it("should not lose `id:` when `\\r` lands at a chunk end (cut waits for the next chunk, or Last-Event-ID is void)", () => {
    const text = 'id: 2\r\ndata: {"type":"doc.changed","path":"a.html"}\r\n\r\n';
    const decoder = createSseDecoder();
    const blocks = chunksAt(text, [byteOfIndex(text, text.indexOf("\r\n") + 1)]);
    expect(decoder.push(blocks[0] ?? bytesOf(""))).toEqual([]);
    expect(decoder.push(blocks[1] ?? bytesOf(""))).toEqual([
      { id: "2", data: '{"type":"doc.changed","path":"a.html"}' },
    ]);
  });

  it("should not mojibake when a multi-byte UTF-8 char is split by a chunk boundary", () => {
    // The blade must land **inside** `文`: cutting between two chars only proves the data line survived, not streaming decode.
    const frames = drainOf(chunksAt(DOC_CHANGED, [cutInsideCharOf(DOC_CHANGED, "文档")]));
    expect(frames).toEqual([DOC_CHANGED_FRAME]);
    expect(frames[0]?.data.includes("\uFFFD")).toBe(false);
  });
});

describe("createSseDecoder cross-chunk accumulation", () => {
  it("should still assemble one frame from byte-sized chunks", () => {
    const cuts = Array.from(
      { length: bytesOf(DOC_CHANGED).length - 1 },
      (_item, index) => index + 1,
    );
    expect(drainOf(chunksAt(DOC_CHANGED, cuts))).toEqual([DOC_CHANGED_FRAME]);
  });

  it("should flush the final frame that lacks its blank-line terminator, and not repeat it on a second flush", () => {
    const decoder = createSseDecoder();
    expect(decoder.push(bytesOf('data: {"type":"ready"}'))).toEqual([]);
    expect(decoder.flush()).toEqual([{ data: '{"type":"ready"}' }]);
    expect(decoder.flush()).toEqual([]);
  });
});

describe("createSseDecoder field semantics", () => {
  it("should keep retry out of data and pass `id: 0` verbatim to the subscription layer for `ready`", () => {
    expect(drainOf([bytesOf(READY)])).toEqual([{ id: "0", data: '{"type":"ready"}' }]);
  });

  it("should carry no `id:` field on a `reset` frame", () => {
    const [frame] = drainOf([bytesOf(RESET)]);
    expect(frame).toEqual(RESET_FRAME);
    expect(frame !== undefined && "id" in frame).toBe(false);
  });

  it("should join multiple `data:` lines of one frame with newlines", () => {
    expect(drainOf([bytesOf("data: a\ndata: b\n\n")])).toEqual([{ data: "a\nb" }]);
  });

  it("should treat a field name without a colon as an empty value without crashing", () => {
    expect(drainOf([bytesOf("data\ndata: x\n\n")])).toEqual([{ data: "\nx" }]);
  });

  it("should drop an empty frame that has `id:` but no `data:`", () => {
    expect(drainOf([bytesOf("id: 5\n\n")])).toEqual([]);
  });

  it("should also cut frames on a lone `\\r` (legacy newline)", () => {
    expect(drainOf([bytesOf('data: {"type":"library.changed"}\r\r')])).toEqual([
      { data: '{"type":"library.changed"}' },
    ]);
  });

  it("should not count a giant newline-free body as a frame: set overflowed past the limit and yield no half frame", () => {
    const decoder = createSseDecoder(16);
    expect(decoder.overflowed()).toBe(false);
    expect(decoder.push(bytesOf("data: {"))).toEqual([]);
    expect(decoder.push(bytesOf("x".repeat(64)))).toEqual([]);
    expect(decoder.overflowed()).toBe(true);
    expect(decoder.flush()).toEqual([]);
  });
});
