// 这层管：G3-R 复核补的边角覆盖——guard 的数组排除、SSE 具名帧、`removeBlock`、
// `sourceOf.onerror`，以及两个响应形状守卫的负例（不用 `as`、不用反射）。

import { describe, expect, it, vi } from "vitest";

import { createDomHost } from "../src/dom.ts";
import {
  isRecord,
  numberTextOf,
  stringOf,
  isAnnotationList,
  isDiffResponse,
} from "../src/guard.ts";
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

describe("guard · 批注列表的合法形状", () => {
  it("should accept an annotation envelope and reject everything else", () => {
    const card = { id: "an-1", nodeId: "hr-a", note: "n", status: "pending" as const };

    expect(isAnnotationList({ annotations: [card] })).toBe(true);
    expect(isAnnotationList({ annotations: [], lost: ["an-2"] })).toBe(true);
    // 已解决卡带两个时间/说明字段、失锚卡带 `lost` 字符串、信封带诊断：这些都是**合法**形状，
    // 守卫必须放行——否则服务端多写一个字段，前端就整页拒收。
    expect(
      isAnnotationList({
        annotations: [
          {
            ...card,
            status: "resolved",
            resolvedAt: "2026-01-01T00:00:00.000Z",
            resolutionNote: "已处理",
          },
          { ...card, id: "an-2", lost: "anchor_lost" },
        ],
        diagnostics: ["1 条批注缺 anchor，按整块处理"],
      }),
    ).toBe(true);
    expect(
      isAnnotationList({ annotations: [{ ...card, lost: "orphaned" }], diagnostics: [] }),
    ).toBe(true);
  });
});

describe("guard · 批注列表的非法形状", () => {
  it("should reject an envelope whose fields carry the wrong type", () => {
    const card = { id: "an-1", nodeId: "hr-a", note: "n", status: "pending" as const };

    // 字段给了就要对：`lost` 不是两个枚举值之一、`diagnostics` 不是字符串数组都要拒。
    expect(isAnnotationList({ annotations: [{ ...card, lost: "gone" }] })).toBe(false);
    expect(isAnnotationList({ annotations: [card], diagnostics: [1] })).toBe(false);
    expect(isAnnotationList({ annotations: [{ ...card, status: "done" }] })).toBe(false);
    // 缺 `annotations` / 不是数组 / 根本不是对象：一律 false，绝不能“差不多就放行”。
    expect(isAnnotationList({})).toBe(false);
    expect(isAnnotationList({ annotations: null })).toBe(false);
    expect(isAnnotationList({ annotations: "x" })).toBe(false);
    expect(isAnnotationList([])).toBe(false);
    expect(isAnnotationList(null)).toBe(false);
  });
});

describe("guard · 服务端 diff 的形状守卫", () => {
  it("should accept a diff envelope only when chunks is an array and degraded is boolean", () => {
    expect(
      isDiffResponse({ nodeId: "hr-a", chunks: [{ kind: "ins", text: "x" }], degraded: false }),
    ).toBe(true);
    expect(isDiffResponse({ nodeId: "hr-a", chunks: [], degraded: true })).toBe(true);
    expect(isDiffResponse({ nodeId: "hr-a", chunks: [{ kind: "same", text: "x" }] })).toBe(false);
    expect(isDiffResponse({ nodeId: "hr-a", chunks: [], degraded: "false" })).toBe(false);
    expect(isDiffResponse({ nodeId: "hr-a", chunks: {}, degraded: false })).toBe(false);
    // 缺 `nodeId` 同样不放行：面板靠它标块，没它就只能猜（裁定 D.4）。
    expect(isDiffResponse({ chunks: [], degraded: false })).toBe(false);
    expect(isDiffResponse("nope")).toBe(false);
    // 三档降级都会带原因（一句话，直接显示）：有了就要是字符串，不是字符串仍要拒。
    expect(
      isDiffResponse({ nodeId: "hr-a", chunks: [], degraded: true, degradedReason: "块已重建" }),
    ).toBe(true);
    expect(isDiffResponse({ nodeId: "hr-a", chunks: [], degraded: true, degradedReason: 3 })).toBe(
      false,
    );
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
