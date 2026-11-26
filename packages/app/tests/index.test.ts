// 这层管：包的公开面（`src/index.ts`）——导出集合是契约，少一个都算破坏。
// 断言一律钉**具名集合**，不钉数目：数目涨了只能告诉你"变了多少"，说不出"变的是什么"；
// 具名集合增删任何一个都会红，且红的时候直接读出名字。

import { describe, expect, it } from "vitest";

import * as publicApi from "../src/index.ts";

/** 公共面导出的具名清单（`src/index.ts` 的 `export` 语句逐条对应）。
 *  新增导出 = 声称"配对侧要用它"：在这里加名字，并在下面补一条 `toBeTypeOf` 检查具体形状。 */
const PUBLIC_SURFACE: readonly string[] = [
  "REQUIRED_ANCHORS",
  "boot",
  "createSse",
  "createStore",
  "createStyleSwitch",
  "initialState",
  "intentOf",
  "missingAnchorsOf",
  "reduce",
];

/** 模板锚点清单的具名快照（`src/anchors.ts` 的 `REQUIRED_ANCHORS`）。
 *  锚点少一个，`boot` 会在状态栏可见地失败——所以这份清单就是"UI 必须存在的元素"契约。
 *  改模板/加交互 = 改这里；删锚点同理。 */
const REQUIRED_ANCHOR_IDS: readonly string[] = [
  "#hr-canvas",
  "#hr-conn",
  "#hr-controls",
  "#hr-diff",
  "#hr-diff-chunks",
  "#hr-diff-status",
  "#hr-doc",
  "#hr-focus-label",
  "#hr-foreign",
  "#hr-foreign-action",
  "#hr-foreign-error",
  "#hr-foreign-frame",
  "#hr-foreign-text",
  "#hr-hint",
  "#hr-lib-title",
  "#hr-library",
  "#hr-note-btn",
  "#hr-note-cancel",
  "#hr-note-draft",
  "#hr-note-editor",
  "#hr-note-error",
  "#hr-note-submit",
  "#hr-notes",
  "#hr-notes-actions",
  "#hr-notes-body",
  "#hr-notes-pending",
  "#hr-notes-resolved",
  "#hr-notes-title",
  "#hr-immersive-btn",
  "#hr-perms",
  "#hr-perm-scripts",
  "#hr-perm-network",
  "#hr-present",
  "#hr-present-btn",
  "#hr-present-exit",
  "#hr-present-pager",
  "#hr-root",
  "#hr-search",
  "#hr-shortcuts",
  "#hr-statusbar",
  "#hr-theme",
  "#hr-theme-label",
  "#hr-theme-select",
  "#hr-toc",
  "#hr-toc-title",
  "#hr-version",
];

describe("index · 公共面", () => {
  it("should export exactly the named public surface, with every name callable as declared", () => {
    expect(Object.keys(publicApi).sort()).toEqual([...PUBLIC_SURFACE].sort());

    // 逐个点名检查形状：增删一个导出上面就会红，这里保证"名字在、东西也对"。
    for (const name of PUBLIC_SURFACE) {
      expect(publicApi).toHaveProperty(name);
    }
    expect(publicApi.boot).toBeTypeOf("function");
    expect(publicApi.createStore).toBeTypeOf("function");
    expect(publicApi.createSse).toBeTypeOf("function");
    expect(publicApi.createStyleSwitch).toBeTypeOf("function");
    expect(publicApi.initialState).toBeTypeOf("function");
    expect(publicApi.intentOf).toBeTypeOf("function");
    expect(publicApi.missingAnchorsOf).toBeTypeOf("function");
    expect(publicApi.reduce).toBeTypeOf("function");
    expect(Array.isArray(publicApi.REQUIRED_ANCHORS)).toBe(true);
  });

  it("should pin REQUIRED_ANCHORS to the named anchor list, without duplicates", () => {
    expect([...publicApi.REQUIRED_ANCHORS].sort()).toEqual([...REQUIRED_ANCHOR_IDS].sort());
    expect(new Set(publicApi.REQUIRED_ANCHORS).size).toBe(REQUIRED_ANCHOR_IDS.length);
  });
});
