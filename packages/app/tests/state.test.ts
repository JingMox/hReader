// 这层管：`reduce` 的引用语义（"没变就返回同一引用"）与各 intent 的分支——store 不通知订阅者全靠它。

import { describe, expect, it } from "vitest";

import { initialState, reduce, type ReaderState } from "../src/state.ts";
import { outlineOf, stateOf } from "./support/fake-host.ts";

const base = (): ReaderState => stateOf({ activeId: "hr-a" });

describe("reduce · 引用语义（没变就返回原对象）", () => {
  it("should return the same reference for a no-op block list and outline", () => {
    const state = stateOf();
    expect(
      reduce(state, { kind: "blocksLoaded", blocks: ["hr-a", "hr-b"], outline: state.outline }),
    ).toBe(state);
  });

  it("should return the same reference when moving past the last block", () => {
    const state = stateOf({ activeId: "hr-b" });
    expect(reduce(state, { kind: "move", delta: 1 })).toBe(state);
  });

  it("should return the same reference when moving before the first block", () => {
    const state = stateOf({ activeId: "hr-a" });
    expect(reduce(state, { kind: "move", delta: -1 })).toBe(state);
  });

  it("should return the same reference for an unchanged outline reference", () => {
    const state = stateOf();
    expect(reduce(state, { kind: "outlineLoaded", outline: state.outline })).toBe(state);
  });
});

describe("reduce · 引用语义（intent 级别的空操作）", () => {
  it("should return the same reference when the connection state is unchanged", () => {
    const state = stateOf({ conn: "live" });
    expect(reduce(state, { kind: "conn", conn: "live" })).toBe(state);
  });

  it("should return the same reference when selecting the already requested theme", () => {
    const state = stateOf({ theme: "manuscript", themeRequested: "manuscript" });
    expect(reduce(state, { kind: "themeSelected", theme: "manuscript" })).toBe(state);
  });

  it("should only move themeRequested until the switch settles", () => {
    const pending = reduce(stateOf({ theme: "a", themeRequested: "a" }), {
      kind: "themeSelected",
      theme: "b",
    });
    expect(pending.theme).toBe("a");
    expect(pending.themeRequested).toBe("b");
    expect(pending.themePending).toBe(true);
  });
});

describe("reduce · 引用语义（intent 级别的空操作·续）", () => {
  it("should return the same reference when a theme is already pending", () => {
    const state = stateOf({ themePending: true });
    expect(reduce(state, { kind: "themeSelected", theme: "manuscript" })).toBe(state);
  });

  it("should return the same reference when closing an already closed panel", () => {
    const state = stateOf();
    expect(reduce(state, { kind: "panelClosed" })).toBe(state);
  });

  it("should return the same reference when the search box is already open", () => {
    const state = stateOf({ searchOpen: true });
    expect(reduce(state, { kind: "searchOpened" })).toBe(state);
  });

  it("should return the same reference when scrolling to the active block", () => {
    const state = base();
    expect(reduce(state, { kind: "scrollTo", id: "hr-a" })).toBe(state);
  });
});

describe("reduce · 移动（首块之前）", () => {
  it("should land on the first block when nothing is active yet", () => {
    const state = stateOf({ activeId: undefined });
    expect(reduce(state, { kind: "move", delta: -1 }).activeId).toBe("hr-a");
  });
});

describe("reduce · 移动与边界", () => {
  it("should step forward and backward by one block", () => {
    const state = base();
    const next = reduce(state, { kind: "move", delta: 1 });
    expect(next.activeId).toBe("hr-b");
    expect(reduce(next, { kind: "move", delta: -1 }).activeId).toBe("hr-a");
  });

  it("should clamp a forward move from the middle to the last block without wrapping", () => {
    const state = stateOf({ activeId: "hr-a", blocks: ["hr-a", "hr-b", "hr-c"] });
    const two = reduce(reduce(state, { kind: "move", delta: 1 }), { kind: "move", delta: 1 });
    expect(two.activeId).toBe("hr-c");
    expect(reduce(two, { kind: "move", delta: 1 })).toBe(two);
  });

  it("should toggle focus and scroll to an arbitrary block", () => {
    const state = stateOf({ focus: false });
    expect(reduce(state, { kind: "toggleFocus" }).focus).toBe(true);
    expect(reduce(state, { kind: "scrollTo", id: "hr-b" }).activeId).toBe("hr-b");
  });
});

describe("reduce · 文档与大纲", () => {
  it("should keep the active block across a document change when it still exists", () => {
    const state = base();
    const next = reduce(state, {
      kind: "documentChanged",
      revision: "abc",
      blocks: ["hr-b", "hr-a"],
    });
    expect(next.activeId).toBe("hr-a");
    expect(next.revision).toBe("abc");
  });

  it("should fall back to the first block when the active one disappears", () => {
    const state = base();
    const next = reduce(state, { kind: "documentChanged", revision: "abc", blocks: ["hr-z"] });
    expect(next.activeId).toBe("hr-z");
  });

  it("should keep the previous block list and html when the change omits them", () => {
    const state = stateOf({ documentHtml: "<p>old</p>" });
    const next = reduce(state, { kind: "documentChanged", revision: "abc" });
    expect(next.blocks).toEqual(state.blocks);
    expect(next.documentHtml).toBe("<p>old</p>");
  });
});

describe("reduce · outlineLoaded 的引用短路", () => {
  it("should return the same reference when the outline array is unchanged", () => {
    const outline = outlineOf();
    const state = stateOf({ outline });
    expect(reduce(state, { kind: "outlineLoaded", outline })).toBe(state);
    const other = reduce(state, {
      kind: "outlineLoaded",
      outline: [{ id: "hr-z", level: 1, text: "z" }],
    });
    expect(other).not.toBe(state);
    expect(other.outline).toHaveLength(1);
  });
});

describe("reduce · blocksLoaded 的边界", () => {
  it("should adopt the first block and the html on the first blocksLoaded", () => {
    const state = initialState("doc.html", "atelier-editorial");
    const next = reduce(state, {
      kind: "blocksLoaded",
      blocks: ["hr-a"],
      outline: outlineOf(),
      html: "<article/>",
    });
    expect(next.activeId).toBe("hr-a");
    expect(next.documentHtml).toBe("<article/>");
  });

  it("should keep the old html when blocksLoaded omits it", () => {
    const state = stateOf({ documentHtml: "<p>keep</p>" });
    const next = reduce(state, {
      kind: "blocksLoaded",
      blocks: ["hr-a", "hr-b"],
      outline: outlineOf(),
    });
    expect(next.documentHtml).toBe("<p>keep</p>");
  });

  it("should rebuild when only the html changed", () => {
    const state = stateOf({ documentHtml: "<p>a</p>" });
    const next = reduce(state, {
      kind: "blocksLoaded",
      blocks: [...state.blocks],
      outline: state.outline,
      html: "<p>b</p>",
    });
    expect(next).not.toBe(state);
    expect(next.documentHtml).toBe("<p>b</p>");
  });
});

describe("reduce · 面板 / 连接 / 主题", () => {
  it("should open a sidenote and mark its block active", () => {
    const next = reduce(stateOf(), { kind: "openSidenote", id: "hr-b" });
    expect(next.panel).toBe("sidenote");
    expect(next.sidenoteId).toBe("hr-b");
    expect(next.activeId).toBe("hr-b");
  });

  it("should return the same reference when opening the same sidenote twice", () => {
    const once = reduce(stateOf(), { kind: "openSidenote", id: "hr-b" });
    expect(reduce(once, { kind: "openSidenote", id: "hr-b" })).toBe(once);
  });

  it("should close the panel and open the search box", () => {
    const open = reduce(stateOf(), { kind: "openSidenote", id: "hr-b" });
    expect(reduce(open, { kind: "panelClosed" }).panel).toBe("closed");
    expect(reduce(stateOf(), { kind: "searchOpened" }).searchOpen).toBe(true);
  });

  it("should mark a theme pending and settle it on success", () => {
    const pending = reduce(stateOf({ theme: "a", themeRequested: "a" }), {
      kind: "themeSelected",
      theme: "b",
    });
    expect(pending.themePending).toBe(true);
    expect(pending.themeRequested).toBe("b");
    const settled = reduce(pending, { kind: "themeSettled", theme: "b", ok: true });
    expect(settled.themePending).toBe(false);
    expect(settled.theme).toBe("b");
    expect(settled.themeRequested).toBe("b");
  });
});

describe("reduce · 主题失败回退", () => {
  it("should roll the select back to the theme that is really applied", () => {
    const pending = reduce(stateOf({ theme: "a", themeRequested: "a" }), {
      kind: "themeSelected",
      theme: "b",
    });
    const failed = reduce(pending, { kind: "themeSettled", theme: "b", ok: false });
    expect(failed.theme).toBe("a");
    expect(failed.themeRequested).toBe("a");
    expect(failed.themePending).toBe(false);
  });

  it("should only clear pending when the failure belongs to another theme", () => {
    const state = stateOf({ theme: "x", themePending: true });
    const settled = reduce(state, { kind: "themeSettled", theme: "y", ok: false });
    expect(settled.theme).toBe("x");
    expect(settled.themePending).toBe(false);
  });

  it("should record the connection state", () => {
    expect(reduce(stateOf({ conn: "connecting" }), { kind: "conn", conn: "live" }).conn).toBe(
      "live",
    );
  });
});
