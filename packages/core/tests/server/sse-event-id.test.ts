// 这层管：SSE `id:` 转义可逆性——反斜杠先转义再折换行，回放不退化、绝不伪造帧。

import { describe, expect, it } from "vitest";

import type { SseEvent } from "../../src/server/contracts";
import { createEventRing, frameOf, frameTokenOf } from "../../src/server/event-ring";
import { createHub } from "../../src/server/hub";
import { responseLike } from "./casts";

/** `SseEvent.id` 声明为 number；这里用 Reflect 造一个"坏"id 来验证输出层必须改写它。 */
const withId = (id: unknown): SseEvent => {
  const event: SseEvent = { id: 0, type: "doc.changed", payload: {} };
  Reflect.set(Object(event), "id", id);
  return event;
};

const idLineOf = (frame: string): string => frame.split("\n")[0] ?? "";

describe("frameTokenOf · 三类输入", () => {
  it.each([
    ["a\\nb", "a\\\\nb"],
    ["a\nb", "a-b"],
    ["a\r\nb", "a--b"],
    ["7", "7"],
  ])("should encode %j as %j", (raw, expected) => {
    expect(frameTokenOf(raw)).toBe(expected);
  });

  it("should report once when and only when something changed", () => {
    const notes: string[] = [];
    frameTokenOf("7", (message) => notes.push(message));
    expect(notes).toHaveLength(0);

    expect(frameTokenOf("a\\b", (message) => notes.push(message))).toBe("a\\\\b");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("已转义");
  });
});

describe("frameOf · id 行的防线", () => {
  it("should never emit a raw newline in the id line (forged frame regression)", () => {
    const frame = frameOf(withId("7\nid: 99\rdata: forged"));

    expect(frame).toContain("id: 7-id: 99-data: forged");
    expect(idLineOf(frame)).toBe("id: 7-id: 99-data: forged");
    expect(frame.split("\n").filter((line) => line.startsWith("id: "))).toHaveLength(1);
    expect(frame.split("\r")).toHaveLength(1);
    expect(frame).not.toContain("\r");
  });

  it("should escape a literal backslash so the round trip is stable", () => {
    const frame = frameOf(withId("a\\nb"));

    expect(idLineOf(frame)).toBe("id: a\\\\nb");
    expect(idLineOf(frame)).not.toContain("a\\nb");
  });
});

describe("data.type 的折叠（反斜杠交给 JSON.stringify）", () => {
  it("should fold a real newline in the event type and report it", () => {
    const notes: string[] = [];
    const frame = frameOf({ id: 1, type: "a\nb", payload: {} }, (m) => notes.push(m));

    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("已折叠");
    expect(frame).toContain('"type":"a-b"');
    expect(frame.split("\n").filter((line) => line.startsWith("data: "))).toHaveLength(1);
  });

  it("should keep a literal backslash for JSON to handle", () => {
    const frame = frameOf({ id: 1, type: "a\\nb", payload: {} });

    // JSON 里字面反斜杠必须成对出现：客户端 JSON.parse 回来仍是 `a\nb`（不是真换行）。
    expect(JSON.parse(frame.split("data: ")[1] ?? "{}")).toEqual({ type: "a\\nb" });
  });
});

describe("Last-Event-ID · 同一编码回放仍命中", () => {
  it("should hit the ring (no reset) when replaying the encoded numeric id", () => {
    const written: string[] = [];
    const ring = createEventRing(8);
    ring.push("doc.changed", { n: 1 });
    ring.push("doc.changed", { n: 2 });
    const hub = createHub({ ring, heartbeatMs: 60_000 });
    const encoded = frameTokenOf("1");

    hub.addClient(
      responseLike({
        writeHead: () => undefined,
        write: (chunk: string) => written.push(chunk),
        end: () => undefined,
        on: () => undefined,
        once: () => undefined,
        flushHeaders: () => undefined,
        destroyed: false,
      }),
      encoded,
    );
    hub.close();

    const text = written.join("");
    expect(text).not.toContain("events_expired");
    expect(text).toContain('"n":2');
  });
});
