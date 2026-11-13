// 这层管：事件环 / 帧格式 / revision / 状态码映射 / 模型差异——全是纯函数，不碰 socket 与文件。

import { describe, expect, it } from "vitest";

import type { HrErrorCode } from "../../src/hr-error";
import type { DocumentModel } from "../../src/model";
import { diffNodes } from "../../src/server/diff-nodes";
import {
  createEventRing,
  frameOf,
  KEEP_ALIVE_FRAME,
  READY_FRAME,
} from "../../src/server/event-ring";
import { revisionOf, REVISION_CHARS } from "../../src/server/revision";
import { statusOf } from "../../src/server/status";

const node = (
  id: string,
  text: string,
  children: readonly DocumentModel[] = [],
): DocumentModel => ({
  id,
  tag: "p",
  text,
  children,
});

describe("createEventRing · 单调 id", () => {
  it("should start empty and hand out increasing ids", () => {
    const ring = createEventRing(4);

    expect(ring.newest()).toBe(0);
    expect(ring.since(0)).toEqual({ hit: true, events: [] });
    expect(ring.push("a", { n: 1 }).id).toBe(1);
    expect(ring.push("b", { n: 2 }).id).toBe(2);
    expect(ring.newest()).toBe(2);
  });

  it("should freeze the event and its payload", () => {
    const event = createEventRing(2).push("a", { n: 1 });

    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.payload)).toBe(true);
  });
});

describe("createEventRing · 容量与补齐", () => {
  it("should backfill only ids strictly newer than the requested one", () => {
    const ring = createEventRing(4);
    ring.push("a", {});
    ring.push("b", {});
    ring.push("c", {});

    expect(ring.since(1).events.map((event) => event.id)).toEqual([2, 3]);
    expect(ring.since(2).events.map((event) => event.id)).toEqual([3]);
    expect(ring.since(3).events).toEqual([]);
  });

  it("should drop the oldest event when capacity is reached (boundary still a hit)", () => {
    const ring = createEventRing(2);
    ring.push("a", {});
    ring.push("b", {});
    ring.push("c", {});

    expect(ring.since(1)).toMatchObject({ hit: true });
    expect(ring.since(1).events.map((event) => event.id)).toEqual([2, 3]);
    expect(ring.since(0)).toEqual({ hit: false, events: [] });
  });

  it("should report a hit with no events when the client is ahead of the ring", () => {
    const ring = createEventRing(2);
    ring.push("a", {});

    expect(ring.since(1)).toEqual({ hit: true, events: [] });
    expect(ring.since(99)).toEqual({ hit: true, events: [] });
  });
});

describe("帧文本 · ready 与 keep-alive", () => {
  it("should pin the exact bytes", () => {
    expect(READY_FRAME).toBe('retry: 2000\nid: 0\ndata: {"type":"ready"}\n\n');
    expect(KEEP_ALIVE_FRAME).toBe(": keep-alive\n\n");
  });
});

describe("帧文本 · data 内的换行必须被转义", () => {
  it("should not let a payload forge extra frames", () => {
    const frame = frameOf({ id: 7, type: "doc.changed", payload: { id: "a\nid: 8\n\n" } });

    expect(frame.startsWith("id: 7\ndata: {")).toBe(true);
    expect(frame.endsWith("}\n\n")).toBe(true);
    expect(frame.split("\n\n")).toHaveLength(2);
    expect(frame).toContain('"a\\nid: 8\\n\\n"');
  });
});

describe("revisionOf · 内容哈希前缀", () => {
  it("should be a stable 16-char lowercase hex prefix of sha256", () => {
    const revision = revisionOf(new TextEncoder().encode("hello"));

    expect(revision).toHaveLength(REVISION_CHARS);
    expect(revision).toMatch(/^[0-9a-f]{16}$/u);
    expect(revisionOf(new TextEncoder().encode("hello"))).toBe(revision);
    expect(revisionOf(new TextEncoder().encode("hello!"))).not.toBe(revision);
  });
});

const STATUS_CASES: readonly (readonly [HrErrorCode, number])[] = [
  ["invalid_html", 400],
  ["no_article", 422],
  ["node_not_found", 404],
  ["invalid_selector", 400],
  ["invalid_document", 422],
  ["node_not_allowed", 400],
  ["invalid_max_bytes", 400],
  ["invalid_input", 400],
  ["locked", 409],
  ["invalid_fragment", 400],
  ["forbidden_content", 400],
  ["path_outside_workspace", 403],
  ["not_a_file", 404],
  ["io_failure", 500],
  ["invalid_utf8", 500],
  ["undo_unavailable", 409],
  ["invalid_style", 400],
  ["unknown_style", 404],
  ["invalid_theme", 400],
  ["style_io_failure", 500],
  ["not_found", 404],
  ["invalid_request", 400],
  ["busy", 503],
  ["too_many_clients", 429],
  ["unauthorized", 401],
  ["forbidden_origin", 403],
  ["daemon_already_running", 409],
];

describe("statusOf · 冻结错误码 → HTTP 状态", () => {
  it.each(STATUS_CASES)("should map %s to %i", (code, status) => {
    expect(statusOf(code)).toBe(status);
  });

  it("should cover the whole frozen table without a fallthrough", () => {
    expect(STATUS_CASES.map(([code]) => code)).toHaveLength(27);
    expect(STATUS_CASES.every(([, status]) => status >= 400)).toBe(true);
  });
});

describe("diffNodes · 先序新增/变化 + 旧序删除", () => {
  it("should list new nodes first and deleted nodes last", () => {
    const prev: DocumentModel = {
      ...node("root", ""),
      children: [node("a", "old"), node("gone", "x")],
    };
    const next: DocumentModel = {
      ...node("root", ""),
      children: [node("a", "new"), node("fresh", "y")],
    };

    expect(diffNodes(prev, next)).toEqual(["a", "fresh", "gone"]);
  });

  it("should treat tag and component changes as changes", () => {
    const prev: DocumentModel = { ...node("root", ""), children: [node("a", "same")] };
    const tagged: DocumentModel = {
      ...node("root", ""),
      children: [{ ...node("a", "same"), tag: "h2" }],
    };
    const component: DocumentModel = {
      ...node("root", ""),
      children: [{ ...node("a", "same"), component: "aside" }],
    };

    expect(diffNodes(prev, tagged)).toEqual(["a"]);
    expect(diffNodes(prev, component)).toEqual(["a"]);
  });

  it("should return an empty list for identical models", () => {
    const model: DocumentModel = { ...node("root", ""), children: [node("a", "x")] };

    expect(diffNodes(model, model)).toEqual([]);
  });
});
