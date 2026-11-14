// 这层管：`rawSelectionOf`/`selectionIntentOf`（`packages/app/src/widgets/selection.ts`）——
// 选区 → 描述 → 意图的纯函数。两条路都要测：注入了 `measure`（真字符偏移）与没注入（退回 anchor/focus 偏移）。
import { describe, expect, it } from "vitest";

import { annotationIntentOf } from "../src/wiring.ts";
import type { MeasureLike } from "../src/widgets/selection.ts";
import { rawSelectionOf, selectionIntentOf } from "../src/widgets/selection.ts";

interface FakeBlock {
  readonly textContent: string | null;
  readonly getAttribute: (name: string) => string | null;
  readonly closest: (selector: string) => FakeBlock | null;
}

const blockOf = (id: string | null, text: string | null = "正文"): FakeBlock => {
  const block: FakeBlock = {
    textContent: text,
    getAttribute: (name) => (name === "data-hr-id" ? id : null),
    closest: (selector) => (selector === "[data-hr-id]" && id !== null ? block : null),
  };
  return block;
};

const selectionOf = (
  block: FakeBlock | null,
  overrides: Readonly<Record<string, unknown>> = {},
): Parameters<typeof rawSelectionOf>[0] => ({
  anchorNode: block === null ? null : { parentElement: { closest: block.closest } },
  anchorOffset: 1,
  focusNode: null,
  focusOffset: 3,
  ...overrides,
});

const measureOf = (offsets: { start: number; end: number }, cross: boolean): MeasureLike => ({
  offsets: () => offsets,
  crossBlock: () => cross,
});

describe("rawSelectionOf · 没有 measure 时退回 anchor/focus 偏移", () => {
  it("should use the raw offsets and compare the two ends by identity", () => {
    const anchorNode = { parentElement: { closest: blockOf("hr-a").closest } };
    const raw = rawSelectionOf({
      anchorNode,
      anchorOffset: 1,
      // 同一个节点对象 ⇒ 不跨块；偏移直接取 anchorOffset/focusOffset（旧调用方的语义）。
      focusNode: anchorNode,
      focusOffset: 3,
    });

    expect(raw).toStrictEqual({
      nodeId: "hr-a",
      blockText: "正文",
      start: 1,
      end: 3,
      crossBlock: false,
    });
  });

  it("should be crossBlock when the focus node is a different object", () => {
    const raw = rawSelectionOf(
      selectionOf(blockOf("hr-a"), { focusNode: { parentElement: { closest: () => null } } }),
    );

    expect(raw?.crossBlock).toBe(true);
  });
});

describe("rawSelectionOf · 注入 measure 时用它的结果", () => {
  it("should take the measured offsets and the measured crossBlock flag", () => {
    const raw = rawSelectionOf(selectionOf(blockOf("hr-a")), measureOf({ start: 7, end: 9 }, true));

    expect(raw?.start).toBe(7);
    expect(raw?.end).toBe(9);
    expect(raw?.crossBlock).toBe(true);
  });
});

describe("rawSelectionOf · 缺字段一律 undefined", () => {
  it("should return undefined when the closest() call finds no block", () => {
    // `[data-hr-id]` 祖先查不到：不是“空 id 的块”，而是根本无从归属。
    expect(rawSelectionOf(selectionOf(blockOf(null)))).toBeUndefined();
  });

  it("should return undefined when the selection is null", () => {
    expect(rawSelectionOf(null)).toBeUndefined();
  });

  it("should return undefined when the block has no textContent", () => {
    expect(rawSelectionOf(selectionOf(blockOf("hr-a", null)))).toBeUndefined();
  });

  it("should return undefined when the anchor node has no parentElement", () => {
    const raw = rawSelectionOf({
      anchorNode: { parentElement: null },
      anchorOffset: 0,
      focusNode: null,
      focusOffset: 0,
    });

    expect(raw).toBeUndefined();
  });
});

describe("rawSelectionOf · 块在但取不到 data-hr-id", () => {
  it("should fall back to an empty nodeId instead of undefined", () => {
    const anonymous = {
      textContent: "正文",
      getAttribute: () => null,
      closest: (selector: string) => (selector === "[data-hr-id]" ? anonymous : null),
    };
    const raw = rawSelectionOf({
      anchorNode: { parentElement: { closest: anonymous.closest } },
      anchorOffset: 1,
      focusNode: null,
      focusOffset: 2,
    });

    // `?? ""` 的意义：nodeId 是 string，不能把 null 漏下去（下游 `nodeId === annotation.nodeId` 会静默失配）。
    expect(raw?.nodeId).toBe("");
  });
});

describe("selectionIntentOf · 选区 → 意图", () => {
  it("should build an anchor with the context around the exact text", () => {
    const intent = selectionIntentOf({
      nodeId: "hr-a",
      blockText: "abcdef",
      start: 1,
      end: 3,
      crossBlock: false,
    });

    expect(intent).toStrictEqual({
      kind: "annotate",
      nodeId: "hr-a",
      anchor: { exact: "bc", prefix: "a", suffix: "def", start: 1 },
    });
  });

  it("should be crossBlock for a selection that spans blocks", () => {
    const intent = selectionIntentOf({
      nodeId: "hr-a",
      blockText: "正文",
      start: 1,
      end: 3,
      crossBlock: true,
    });

    expect(intent.kind).toBe("crossBlock");
  });
});

describe("selectionIntentOf · 夹取与空选区", () => {
  it("should be empty for a whitespace-only selection", () => {
    const intent = selectionIntentOf({
      nodeId: "hr-a",
      blockText: "a  b",
      start: 1,
      end: 3,
      crossBlock: false,
    });

    expect(intent.kind).toBe("empty");
  });

  it("should clamp offsets outside the block text instead of slicing them raw", () => {
    const intent = selectionIntentOf({
      nodeId: "hr-a",
      blockText: "abc",
      start: 2,
      end: 99,
      crossBlock: false,
    });

    expect(intent.kind === "annotate" && intent.anchor.exact).toBe("c");
  });

  it("should clamp a reversed range to an empty selection", () => {
    // end < start：end 被夹到 start，exact 为空 ⇒ empty（不是把两个偏移直接喂给 slice）。
    const intent = selectionIntentOf({
      nodeId: "hr-a",
      blockText: "abc",
      start: 2,
      end: 0,
      crossBlock: false,
    });

    expect(intent.kind).toBe("empty");
  });
});

describe("annotationIntentOf · wiring 的转发", () => {
  it("should refuse a cross-block selection", () => {
    const intent = annotationIntentOf({
      nodeId: "hr-a",
      blockText: "正文",
      start: 1,
      end: 3,
      crossBlock: true,
    });

    expect(intent.kind).toBe("crossBlock");
  });
});
