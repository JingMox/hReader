// 这层管：键盘 → intent 的纯映射（单键、修饰键抑制、可编辑目标抑制、c 无活动块）。

import { describe, expect, it } from "vitest";

import { intentOf, type KeyLike } from "../src/keys.ts";
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
