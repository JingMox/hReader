// docs/05:57：`replace` 的片段根自带 `data-hr-id` 时那是"被忽略"，片段**内部**其它可寻址节点由产品
// 重新分配——人读回执要把"id 变更"与"顺带新增的 id"两段都印出来，映射之外的为空时又必须整段消失
// （留下 ", +0 ids: " 等于凭空报了个空列表）。
//
// 这层是 `output.ts` 的**进程内**单测：`patch` 的 CLI e2e 走子进程，覆盖率收不到，边长靠这里钉
// （产品级的两段提示在 `r2-replace-extra-ids.test.ts` 里另钉一遍）。

import { describe, expect, it } from "vitest";

import type { PatchResult } from "@hreader/core";

import { humanPatch } from "../src/output";

/** 片段根 id 被忽略、落回目标 id，片段内部还带出两个新 id。 */
const WITH_EXTRAS: PatchResult = {
  path: "b.html",
  bytes: 149,
  newIds: ["p-1-2", "hr-x1", "hr-x2"],
  replacedIds: [{ from: "hr-a392514c", to: "p-1-2" }],
  changed: true,
  historyPath: null,
  undoable: false,
};

/** 同样是一次"片段 id 被忽略"，但片段里没有更深层的可寻址节点。 */
const NO_EXTRAS: PatchResult = { ...WITH_EXTRAS, newIds: ["p-1-2"] };

describe("output · replace 之后的人读回执（docs/05:57）", () => {
  it("should print the mapping and then the extra ids the fragment brought along", () => {
    expect(humanPatch(WITH_EXTRAS)).toBe(
      "patched b.html (149 bytes, id 变更: hr-a392514c → p-1-2, +2 ids: hr-x1, hr-x2)\n",
    );
  });

  it("should drop the extra-ids tail entirely when every new id is already mapped", () => {
    expect(humanPatch(NO_EXTRAS)).toBe(
      "patched b.html (149 bytes, id 变更: hr-a392514c → p-1-2)\n",
    );
  });
});
