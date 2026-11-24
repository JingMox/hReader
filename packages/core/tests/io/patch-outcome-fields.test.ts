// 这层管：`PatchOutcome` 的两个"附加返回面"——片段解析诊断（`warnings`）与 id 变更对
// （`replacedIds`）。它们都是"字节写成功了，但用户需要知道发生了什么"的机器可读渠道：
// 丢掉 `warnings` = 属性悄悄少了一个；`replacedIds` 恒为空（`replace` 保 id），
// 键仍留在返回面里，所以这里锁住"它确实是空数组、不是 undefined"。

import { describe, expect, it } from "vitest";

import type { PatchRequest } from "../../src/ops/patch-node";
import { applyPatch } from "../../src/ops/patch-node";

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
  it("should ignore the fragment's own id and say so in warnings", () => {
    // 片段自带的 `data-hr-id` 一律忽略，写进文档的是继承来的目标 id。
    const outcome = patch({
      targetId: "p1",
      action: "replace",
      html: '<p data-hr-id="hr-deadbeef">换</p>',
    });

    expect(outcome.newIds).toEqual([]);
    expect(outcome.warnings.map((warning) => warning.code)).toContain("fragment_ids_ignored");
    expect(outcome.html).toContain('data-hr-id="p1"');
    expect(outcome.html).not.toContain("hr-deadbeef");
  });

  it("should report no pair on replace because the new root inherits the target id", () => {
    // `replace` 的新根继承目标自己的 id ⇒ `from === to`，不构成变更对。
    const outcome = patch({ targetId: "p1", action: "replace", html: "<p>换</p>" });

    expect(outcome.changed).toBe(true);
    expect(outcome.replacedIds).toEqual([]);
    expect(outcome.newIds).toEqual([]);
    expect(outcome.html).toContain('data-hr-id="p1"');
  });

  it("should report no pair for actions that never swap the root id", () => {
    expect(patch({ targetId: "p1", action: "append", html: "<b>粗</b>" }).replacedIds).toEqual([]);
    expect(patch({ targetId: "p1", action: "delete" }).replacedIds).toEqual([]);
  });
});

describe("applyPatch · replacedIds 的预置红", () => {
  it("should report the ignored fragment id as one pair whose `to` is the inherited target id", () => {
    // RULING-1：`replacedIds` = 「片段根自带的 id 被忽略」：`from` = 片段带来的 id、`to` = 继承到的目标 id。
    const outcome = patch({
      targetId: "p1",
      action: "replace",
      html: '<p data-hr-id="hr-deadbeef">换</p>',
    });

    expect(outcome.replacedIds).toEqual([{ from: "hr-deadbeef", to: "p1" }]);
  });
});
