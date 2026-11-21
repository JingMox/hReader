// 这层测：`measureSelection()`（`packages/app/src/measure.ts`）——浏览器 `Range` 的最小包装。
// 直接替换全局 `document` / `window`：偏移换算只依赖这两个全局，不需要真 DOM（裁定 #11）。
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BlockElementLike, MeasureLike, SelectionLike } from "../src/widgets/selection.ts";

interface FakeRange {
  text: string;
  selectNodeContents: (node: unknown) => void;
  setEnd: (node: unknown, offset: number) => void;
  toString: () => string;
}

/** `Range.toString()` 的语义就是"从块头到 offset"——假 range 照抄这条，测的才是真换算。 */
const rangeOf = (): FakeRange => ({
  text: "",
  selectNodeContents(node) {
    this.text = String(node);
  },
  setEnd(_node, offset) {
    this.text = this.text.slice(0, offset);
  },
  toString() {
    return this.text;
  },
});

/** `closest` 必须返回**同一个对象**：`measure.ts` 用 `!==` 比较两次 `closest()` 的结果。 */
const blockOf = (id: string, text = "正文"): BlockElementLike => {
  const element = {
    textContent: text,
    getAttribute: (name: string) => (name === "data-hr-id" ? id : null),
  };
  return { ...element, closest: (selector) => (selector === "[data-hr-id]" ? element : null) };
};

const selectionOf = (
  anchor: BlockElementLike | null = blockOf("hr-a"),
  focus: BlockElementLike | null = anchor,
): SelectionLike => ({
  anchorNode: anchor === null ? null : { parentElement: { closest: anchor.closest } },
  focusNodeParent: focus === null ? null : { closest: focus.closest },
  anchorOffset: 0,
  focusNode: null,
  focusOffset: 0,
});

interface RangeEnds {
  readonly startContainer: string;
  readonly startOffset: number;
  readonly endContainer: string;
  readonly endOffset: number;
}

const install = (options: {
  readonly selection?: unknown;
  readonly createRange?: unknown;
}): void => {
  vi.stubGlobal("document", { createRange: options.createRange });
  vi.stubGlobal("window", { getSelection: () => options.selection });
};

const withRange = (ends: RangeEnds, createRange: unknown = rangeOf): void => {
  install({ selection: { rangeCount: 1, getRangeAt: () => ends }, createRange });
};

const call = async (): Promise<MeasureLike> =>
  await import("../src/measure.ts").then((module) => module.measureSelection());

const offsetsOf = async (selection: SelectionLike = selectionOf()): Promise<unknown> =>
  (await call()).offsets(selection);

const SAME: RangeEnds = {
  startContainer: "abcdef",
  startOffset: 1,
  endContainer: "abcdef",
  endOffset: 5,
};

describe("measureSelection · 正常换算", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should measure both ends when the selection is ordered", async () => {
    withRange({ ...SAME, startOffset: 4, endOffset: 2 });

    // 反序的 range（浏览器允许）必须被摆正，而不是把 start/end 直接透传出去。
    expect(await offsetsOf()).toEqual({ start: 2, end: 4 });
  });

  it("should keep start <= end for an already ordered range", async () => {
    withRange(SAME);

    expect(await offsetsOf()).toEqual({ start: 1, end: 5 });
  });

  it("should bind document as this when calling createRange", async () => {
    const boundDoc = {
      createRange(this: unknown) {
        if (this !== boundDoc) throw new TypeError("Illegal invocation");
        return rangeOf();
      },
    };
    vi.stubGlobal("document", boundDoc);
    vi.stubGlobal("window", { getSelection: () => ({ rangeCount: 1, getRangeAt: () => SAME }) });

    expect(await offsetsOf()).toEqual({ start: 1, end: 5 });
  });
});

describe("measureSelection · 拿不到 selection / range 时给零", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should return zeros when the window has no getSelection at all", async () => {
    install({ createRange: rangeOf });

    expect(await offsetsOf()).toEqual({ start: 0, end: 0 });
  });

  it("should return zeros when getSelection returns null", async () => {
    install({ selection: null, createRange: rangeOf });

    expect(await offsetsOf()).toEqual({ start: 0, end: 0 });
  });

  it("should return zeros when the selection has zero ranges", async () => {
    install({ selection: { rangeCount: 0, getRangeAt: () => SAME }, createRange: rangeOf });

    expect(await offsetsOf()).toEqual({ start: 0, end: 0 });
  });

  it("should return zeros when the selection has no getRangeAt", async () => {
    install({ selection: { rangeCount: 1 }, createRange: rangeOf });

    expect(await offsetsOf()).toEqual({ start: 0, end: 0 });
  });

  it("should return zeros when document has no createRange", async () => {
    // 不能给 `withRange` 传 `undefined`：那会命中它的默认参数（换成假 range）。
    install({ selection: { rangeCount: 1, getRangeAt: () => SAME }, createRange: undefined });

    expect(await offsetsOf()).toEqual({ start: 0, end: 0 });
  });
});

describe("measureSelection · 没有块祖先", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should return zeros when the anchor is not inside a block", async () => {
    withRange(SAME);

    expect(await offsetsOf(selectionOf(null))).toEqual({ start: 0, end: 0 });
  });

  it("should return zeros when the anchor has no parentElement", async () => {
    withRange(SAME);

    expect(
      await offsetsOf({
        anchorNode: null,
        anchorOffset: 0,
        focusNode: null,
        focusOffset: 0,
      }),
    ).toEqual({ start: 0, end: 0 });
  });
});

describe("measureSelection · crossBlock", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should be false when both ends sit in the same block", async () => {
    const block = blockOf("hr-a");

    expect((await call()).crossBlock(selectionOf(block, block))).toBe(false);
  });

  it("should be true when the ends sit in different blocks", async () => {
    expect((await call()).crossBlock(selectionOf(blockOf("hr-a"), blockOf("hr-b")))).toBe(true);
  });

  it("should be true when the focus end is outside any block", async () => {
    expect((await call()).crossBlock(selectionOf(blockOf("hr-a"), null))).toBe(true);
  });
});

describe("measureSelection · 焦点容器缺失的退化", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should treat a missing focusNodeParent as no block", async () => {
    const measure = await call();
    const anchor = blockOf("hr-a");
    const { focusNodeParent, ...rest } = selectionOf(anchor);
    expect(focusNodeParent).not.toBeUndefined();
    expect(rest).not.toHaveProperty("focusNodeParent");
    const selection: SelectionLike = rest;

    // `focusNodeParent ?? null`：缺失时必须当"没有块"处理，否则 `blockOf(undefined)` 会抛。
    expect(measure.crossBlock(selection)).toBe(true);
  });

  it("should fall back to focusNode.parentElement when focusNodeParent is omitted", async () => {
    const measure = await call();
    const anchor = blockOf("hr-a");
    const selection: SelectionLike = {
      anchorNode: { parentElement: { closest: anchor.closest } },
      anchorOffset: 0,
      focusNode: { parentElement: { closest: anchor.closest } },
      focusOffset: 2,
    };

    expect(measure.crossBlock(selection)).toBe(false);
  });
});

describe("measureSelection · crossBlock 的起始锚点为空", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should be crossBlock when the anchor end is null but the focus end is a block", async () => {
    const measure = await call();
    const selection: SelectionLike = {
      anchorNode: null,
      focusNodeParent: { closest: blockOf("hr-b").closest },
      anchorOffset: 0,
      focusNode: null,
      focusOffset: 0,
    };

    // `selection.anchorNode?.parentElement ?? null` 的**短路臂**：起始侧没有锚点当"无块"，
    // 焦点侧有块 ⇒ 两侧不等 ⇒ 跨块（不是"没有选区就不判跨块"）。
    expect(measure.crossBlock(selection)).toBe(true);
  });

  it("should stay same-block when both ends are missing", async () => {
    const measure = await call();
    const selection: SelectionLike = {
      anchorNode: null,
      focusNodeParent: null,
      anchorOffset: 0,
      focusNode: null,
      focusOffset: 0,
    };

    // 两侧都无块时 `null === null` ⇒ 不算跨块（对照组，证伪“恒 true”）。
    expect(measure.crossBlock(selection)).toBe(false);
  });
});
