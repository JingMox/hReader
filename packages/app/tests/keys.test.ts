// 这层管：键盘 → intent 的纯映射（单键、修饰键抑制、可编辑目标抑制、c 无活动块）。

import { describe, expect, it } from "vitest";

import { intentOf, type KeyLike } from "../src/keys.ts";
import type { ReaderState } from "../src/state.ts";
import { stateOf } from "./support/fake-host.ts";

const key = (name: string, over: Partial<KeyLike> = {}): KeyLike => ({ key: name, ...over });

describe("intentOf · 单键命令", () => {
  it.each([
    ["j", { kind: "move", delta: 1 }],
    ["k", { kind: "move", delta: -1 }],
    ["h", { kind: "toggleFocus" }],
    ["/", { kind: "searchOpened" }],
    ["Escape", { kind: "panelClosed" }],
  ])("should map %s to its intent", (name, expected) => {
    expect(intentOf(key(name), stateOf())).toEqual(expected);
  });

  it("should map c to a sidenote for the active block", () => {
    expect(intentOf(key("c"), stateOf({ activeId: "hr-b" }))).toEqual({
      kind: "openSidenote",
      id: "hr-b",
    });
  });

  it("should ignore c when no block is active", () => {
    expect(intentOf(key("c"), stateOf({ activeId: undefined }))).toBeUndefined();
  });

  it("should ignore keys it does not own", () => {
    expect(intentOf(key("x"), stateOf())).toBeUndefined();
  });

  it.each(["p", "F5"])("should enter present mode on %s", (name) => {
    expect(intentOf(key(name), stateOf())).toEqual({ kind: "presentEntered" });
  });
});

describe("intentOf · 沉浸模式", () => {
  const immersed = (over: Partial<ReaderState> = {}) => stateOf({ immersive: true, ...over });

  it("should toggle immersive on i in reading mode", () => {
    expect(intentOf(key("i"), stateOf())).toEqual({ kind: "immersiveToggled" });
  });

  it("should exit immersive on i or Escape", () => {
    expect(intentOf(key("i"), immersed())).toEqual({ kind: "immersiveToggled" });
    expect(intentOf(key("Escape"), immersed())).toEqual({ kind: "immersiveToggled" });
  });

  it("should prefer exiting immersive over closing a panel on Escape", () => {
    // 侧栏/面板在沉浸里不可见；Esc 先退沉浸，下一次 Esc 才轮到 panelClosed。
    expect(intentOf(key("Escape"), immersed({ panel: "sidenote", sidenoteId: "hr-a" }))).toEqual({
      kind: "immersiveToggled",
    });
  });

  it("should keep the other reading keys working while immersed", () => {
    expect(intentOf(key("j"), immersed())).toEqual({ kind: "move", delta: 1 });
    expect(intentOf(key("p"), immersed())).toEqual({ kind: "presentEntered" });
  });

  it("should not respond to i while presenting", () => {
    const presenting = stateOf({ present: { active: true, page: 0 }, pages: ["a"] });
    expect(intentOf(key("i"), presenting)).toBeUndefined();
    // 演示 + 沉浸叠态同样不响应：演示壳独占键盘，Esc 先退演示。
    expect(intentOf(key("i"), { ...presenting, immersive: true })).toBeUndefined();
    expect(intentOf(key("Escape"), { ...presenting, immersive: true })).toEqual({
      kind: "presentExited",
    });
  });

  it("should suppress i with modifiers and inside editable targets", () => {
    expect(intentOf(key("i", { metaKey: true }), stateOf())).toBeUndefined();
    expect(intentOf(key("i", { ctrlKey: true }), stateOf())).toBeUndefined();
    expect(intentOf(key("i", { target: { tagName: "INPUT" } }), stateOf())).toBeUndefined();
    expect(
      intentOf(key("i", { target: { tagName: "DIV", isContentEditable: true } }), stateOf()),
    ).toBeUndefined();
  });
});

describe("intentOf · 演示态按键", () => {
  const presenting = (over: Partial<ReaderState> = {}) =>
    stateOf({ present: { active: true, page: 1 }, pages: ["a", "b", "c"], ...over });

  it.each([
    ["ArrowRight", { kind: "presentAdvanced" }],
    ["ArrowDown", { kind: "presentAdvanced" }],
    [" ", { kind: "presentAdvanced" }],
    ["PageDown", { kind: "presentAdvanced" }],
    ["ArrowLeft", { kind: "presentBack" }],
    ["ArrowUp", { kind: "presentBack" }],
    ["PageUp", { kind: "presentBack" }],
    ["Home", { kind: "presentMoved", page: 0 }],
    ["End", { kind: "presentMoved", page: 2 }],
    ["Escape", { kind: "presentExited" }],
    ["p", { kind: "presentExited" }],
    ["F5", { kind: "presentExited" }],
  ])("should map %s to its intent", (name, expected) => {
    expect(intentOf(key(name), presenting())).toEqual(expected);
  });

  it.each(["j", "k", "h", "c", "w", "/", "x"])(
    "should swallow the reading-mode key %s while presenting",
    (name) => {
      expect(intentOf(key(name), presenting())).toBeUndefined();
    },
  );

  it("should still let modified keys fall through while presenting", () => {
    expect(intentOf(key("ArrowRight", { metaKey: true }), presenting())).toBeUndefined();
  });

  it.each(["ArrowRight", "ArrowLeft", "PageDown", "PageUp", "Home", "End", " ", "F5"])(
    "should not turn shift+%s into a nav command while presenting",
    (name) => {
      // 阅读态放行 Shift 是给 Shift+D/Shift+J 留的；演示态没有这类命令，
      // Shift+方向键是浏览器的原生组合键，翻页就是误触发。
      expect(intentOf(key(name, { shiftKey: true }), presenting())).toBeUndefined();
    },
  );

  it("should ignore present keys inside editable targets", () => {
    const target = { tagName: "INPUT" };
    expect(intentOf(key("ArrowRight", { target }), presenting())).toBeUndefined();
  });
});

describe("intentOf · 修饰键与可编辑目标", () => {
  it.each([[{ metaKey: true }], [{ ctrlKey: true }], [{ altKey: true }]])(
    "should suppress shortcuts with modifiers %j",
    (over) => {
      expect(intentOf(key("j", over), stateOf())).toBeUndefined();
      expect(intentOf(key("Escape", over), stateOf())).toBeUndefined();
    },
  );

  it("should not treat shift alone as a modifier", () => {
    expect(intentOf(key("j", { shiftKey: true }), stateOf())).toEqual({ kind: "move", delta: 1 });
  });

  it.each(["INPUT", "TEXTAREA", "SELECT", "input"])(
    "should suppress single keys inside %s",
    (tagName) => {
      expect(intentOf(key("j", { target: { tagName } }), stateOf())).toBeUndefined();
    },
  );

  it("should suppress inside a contenteditable element", () => {
    const target = { tagName: "DIV", isContentEditable: true };
    expect(intentOf(key("/", { target }), stateOf())).toBeUndefined();
  });

  it("should keep working on ordinary elements and on a null target", () => {
    expect(intentOf(key("j", { target: { tagName: "DIV" } }), stateOf())).toEqual({
      kind: "move",
      delta: 1,
    });
    expect(intentOf(key("j", { target: null }), stateOf())).toEqual({ kind: "move", delta: 1 });
    expect(intentOf(key("j", { target: {} }), stateOf())).toEqual({ kind: "move", delta: 1 });
  });
});

describe("intentOf · Shift+D 的 diff 快捷键", () => {
  it("should map Shift+D (upper or lower case) to diffToggled", () => {
    expect(intentOf(key("D", { shiftKey: true }), stateOf())).toEqual({ kind: "diffToggled" });
    expect(intentOf(key("d", { shiftKey: true }), stateOf())).toEqual({ kind: "diffToggled" });
  });

  it("should ignore d when shiftKey is absent or false", () => {
    // 键盘适配层会把缺失归一成 `false`；这里直接钉住纯映射本身：判定一旦放宽成
    // `shiftKey !== false`，缺字段的 `d` 就会冒出 diffToggled，第一条断言先红。
    expect(intentOf(key("d"), stateOf())).toBeUndefined();
    expect(intentOf(key("d", { shiftKey: false }), stateOf())).toBeUndefined();
  });
});
