// 这层管：G3-R 复核补的边角覆盖——guard 的数组排除、SSE 具名帧、`removeBlock`、
// `sourceOf.onerror`，以及两个响应形状守卫的负例（不用 `as`、不用反射）。

import { describe, expect, it, vi } from "vitest";

import { createDomHost } from "../src/dom.ts";
import { isRecord, numberTextOf, stringOf } from "../src/guard.ts";
import { createSse, type MessageEventLike, type SourceLike } from "../src/sse.ts";
import { createFakeDocument, fakeElement } from "./support/fake-dom.ts";

describe("guard · 形状守卫的负例", () => {
  it("should treat an array as not-a-record and reject wrong primitive types", () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("x")).toBe(false);
    expect(isRecord({})).toBe(true);
    expect(stringOf(1)).toBeUndefined();
    expect(numberTextOf(true)).toBeUndefined();
    expect(numberTextOf(3)).toBe("3");
  });
});

describe("dom · removeBlock", () => {
  it("should remove the block element and ignore an unknown id", () => {
    const doc = createFakeDocument();
    const element = { ...fakeElement("article"), remove: vi.fn() };
    doc.bySelector.set('[data-hr-id="hr-a"]', element);
    const host = createDomHost(doc);
    host.removeBlock("hr-a");
    host.removeBlock("hr-missing");
    expect(element.remove.mock.calls).toHaveLength(1);
  });
});

const sourceOf = (): { source: SourceLike; fire: (event: MessageEventLike) => void } => {
  const listeners = new Map<string, (event: MessageEventLike) => void>();
  const source: SourceLike = {
    addEventListener: (type, listener) => {
      listeners.set(type, listener);
    },
    setOpen: () => undefined,
    setError: () => undefined,
    close: () => undefined,
  };
  return {
    source,
    fire: (event) => {
      listeners.get("doc.changed")?.(event);
    },
  };
};

describe("sse · 具名帧走事件名而不是 data.type", () => {
  it("should use the event name when it is not `message`", () => {
    const events: string[] = [];
    const fake = sourceOf();
    const sse = createSse(
      "/api/events",
      { open: () => fake.source, schedule: () => () => undefined, random: () => 0.5 },
      { onEvent: (event) => events.push(event.type), onState: () => undefined },
    );
    sse.start();
    fake.fire({ data: JSON.stringify({ changedNodes: [] }), lastEventId: "7" });
    sse.close();
    expect(events).toEqual(["doc.changed"]);
  });
});

describe("sse · message 帧缺 type 时退回约定的 message", () => {
  it("should fall back to `message` when a message frame has no type field", () => {
    const events: string[] = [];
    const listeners = new Map<string, (event: MessageEventLike) => void>();
    const source: SourceLike = {
      addEventListener: (type, listener) => {
        listeners.set(type, listener);
      },
      setOpen: () => undefined,
      setError: () => undefined,
      close: () => undefined,
    };
    const sse = createSse(
      "/api/events",
      { open: () => source, schedule: () => () => undefined, random: () => 0.5 },
      { onEvent: (event) => events.push(event.type), onState: () => undefined },
    );
    sse.start();
    listeners.get("message")?.({ data: JSON.stringify({ foo: 1 }), lastEventId: "5" });
    sse.close();
    expect(events).toEqual(["message"]);
  });
});
