// 这层管：`applyPatch` 里一处**纯防御**分支——`parseFragment` 保证片段根是元素。
//
// `replacedIds` 的组装（`apply.ts` 的 `rootIdOf` / `replacedIdsOf`）仍按"根可能不是元素"写：
// 一旦哪天片段根放宽成文本节点，这里必须退化成"没有 id 可报"，而不是拿 undefined 拼出一对
// `{from, to}` 交给用户。真片段走不到这条路（`parseFragment` 只放行单个元素），
// 所以用 mock 把片段换成文本节点，直接把这条兜底走一遍。
//
// 注：F11 之后 `apply.ts` 的内部调用点是 `parseFragmentWithDiagnostics`（自带 `warnings` 上浮），
// `parseFragment` 只剩对外外壳；mock 必须打在内部调用点上，否则它静默失效。

import { describe, expect, it, vi } from "vitest";

import { applyPatch } from "../../src/ops/patch-node";

vi.mock("../../src/ops/patch-node/fragment", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // 根是文本节点：没有 attrs，也就没有 `data-hr-id`。
    parseFragmentWithDiagnostics: (): unknown => ({
      root: { kind: "text", value: "替换内容" },
      warnings: [],
    }),
  };
});

const DOC = '<article data-hr-id="hr-a"><p data-hr-id="hr-b">正文</p></article>';

describe("applyPatch · 片段根不是元素时的兜底", () => {
  it("should report no replacedIds instead of a pair with undefined ids", () => {
    const outcome = applyPatch(DOC, { targetId: "hr-b", action: "replace", html: "<p>换</p>" });

    // 没有"新 id"就没有可报的替换对：宁可为空，也不能让用户拿着 `to: undefined` 去 patch。
    expect(outcome.replacedIds).toEqual([]);
    // 除了内部字段，也读一眼产物本身。
    expect(outcome.html).toContain("换");
    expect(outcome.changed).toBe(true);
  });
});
