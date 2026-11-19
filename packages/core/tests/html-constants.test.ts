// 这层管：三集合（BLOCK_TAGS / ADDRESSABLE_TAGS / PATCHABLE_TAGS）之间的包含关系；纯数据断言，不碰 IO。
//
// 三条都是模型节点必有 id + "只减项" 的硬前提：
// 1. BLOCK_TAGS ⊆ ADDRESSABLE_TAGS：块级投影出来的每个元素都必须能被寻址（拿到 data-hr-id）。
// 2. PATCHABLE_TAGS ⊆ ADDRESSABLE_TAGS：patch 目标是寻址面的减项，只能减不能凭空加。
// 3. PATCHABLE_TAGS.size <= ADDRESSABLE_TAGS.size：同上，用基数再兜一层（防止同集被悄悄扩大）。
// 破坏任一前提都应在 CI 变红，而不是等到"拿不到 id / 批注无处可挂 / patch 命中不存在的标签"才暴露。

import { ADDRESSABLE_TAGS, BLOCK_TAGS, PATCHABLE_TAGS } from "../src/html/constants";
import { describe, expect, it } from "vitest";

describe("html constants: 三集合关系", () => {
  it("should keep every BLOCK_TAGS entry inside ADDRESSABLE_TAGS", () => {
    const missing = [...BLOCK_TAGS].filter((tag) => !ADDRESSABLE_TAGS.has(tag));
    expect(missing).toEqual([]);
  });

  it("should keep every PATCHABLE_TAGS entry inside ADDRESSABLE_TAGS (only 减项)", () => {
    const missing = [...PATCHABLE_TAGS].filter((tag) => !ADDRESSABLE_TAGS.has(tag));
    expect(missing).toEqual([]);
  });

  it("should not let PATCHABLE_TAGS grow beyond ADDRESSABLE_TAGS", () => {
    expect(PATCHABLE_TAGS.size).toBeLessThanOrEqual(ADDRESSABLE_TAGS.size);
  });
});
