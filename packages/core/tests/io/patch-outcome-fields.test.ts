// 这层管：`PatchOutcome` 的两个"附加返回面"——片段解析诊断（`warnings`）与 `replace` 的 id 变更对
// （`replacedIds`）。它们都是"字节写成功了，但用户需要知道发生了什么"的机器可读渠道：
// 丢掉 `warnings` = 属性悄悄少了一个；丢掉 `replacedIds` = 用户拿着已失效的旧 id 继续 patch。

import { describe, expect, it } from "vitest";

import type { PatchRequest } from "../../src/ops/patchNode";
import { applyPatch } from "../../src/ops/patchNode";

const DOC =
  '<article data-hr-id="root"><h2 data-hr-id="h1">标题</h2>' +
  '<section data-hr-id="box"><p data-hr-id="p1">旧</p></section></article>';

const patch = (request: PatchRequest): ReturnType<typeof applyPatch> => applyPatch(DOC, request);

describe("applyPatch · warnings 上浮片段诊断", () => {
  it("should surface duplicate_attribute from the fragment instead of swallowing it", () => {
    const outcome = patch({
      targetId: "p1",
      action: "replace",
      html: '<p title="a" title="b">新</p>',
    });

    expect(outcome.warnings.map((warning) => warning.code)).toContain("duplicate_attribute");
    // 诊断不能变成拒绝：属性丢了，元素还是得写进去。
    expect(outcome.changed).toBe(true);
    expect(outcome.html).toContain("新");
  });

  it("should report no warnings for a clean fragment", () => {
    expect(patch({ targetId: "p1", action: "replace", html: "<p>新</p>" }).warnings).toStrictEqual(
      [],
    );
  });

  it("should report no warnings when nothing is written", () => {
    // `delete` 不解析片段：`warnings` 必须是空数组，调用方不必分叉。
    expect(patch({ targetId: "p1", action: "delete" }).warnings).toStrictEqual([]);
  });
});

describe("applyPatch · replacedIds 的 id 变更对", () => {
  it("should report one pair whose `to` is the id actually written", () => {
    // F2 口径：`replace` 连旧 id 一起换掉，所以要报一对。`to` 必须与落盘的那个 id 同值——
    // 不硬编码哈希，拿 `newIds[0]` 当变量比。
    const outcome = patch({ targetId: "p1", action: "replace", html: "<p>换</p>" });
    const [replaced] = outcome.replacedIds;

    expect(outcome.replacedIds).toHaveLength(1);
    expect(replaced?.from).toBe("p1");
    expect(replaced?.to).toBe(outcome.newIds[0]);
    expect(outcome.html).toContain(`data-hr-id="${String(outcome.newIds[0])}"`);
  });

  it("should report no pair for actions that keep the target id", () => {
    expect(patch({ targetId: "p1", action: "append", html: "<b>粗</b>" }).replacedIds).toEqual([]);
  });
});
