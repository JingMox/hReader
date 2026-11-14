// P1-3/P1-9：两条"丢掉了但不告诉用户"的路径——
// ① 跨块选区被静默丢弃（AC5.1 要求有可见反馈）；
// ② `GET /annotations` 已经返回 `diagnostics`（core 的 `annotation-replies.ts` 会带），
//    但 app 侧 0 命中，用户永远看不到"你的 meta 有行被跳过了"。

import { describe, expect, it } from "vitest";

import { flush } from "./support/boot-harness.ts";
import {
  bootedWith,
  hintsOf,
  SELECTION,
  selectOf,
  writesContaining,
} from "./support/notes-harness.ts";

describe("跨块选区 · 必须给可见提示（P1-3）", () => {
  it("should tell the user why the cross-block selection was dropped", () => {
    const h = bootedWith();
    // 先有一个合法块内选区："不变"才有对象可断（否则判据是“本来就是 undefined”）。
    selectOf(h, SELECTION);
    const kept = h.store.get().noteTarget;
    expect(kept).toBeDefined();

    selectOf(h, { ...SELECTION, nodeId: "hr-b", crossBlock: true });

    expect(h.store.get().noteTarget).toBe(kept);
    expect(hintsOf(h).join("")).not.toBe("");
    h.booted.destroy();
  });
});

describe("服务端诊断 · 必须送到用户眼前（P1-9）", () => {
  it("should surface the diagnostics returned with the annotation list", async () => {
    const h = bootedWith({ diagnostics: ["hr-meta.annotations[1] 缺少 id/targetId"] });
    await flush();

    expect(writesContaining(h, "缺少 id/targetId")).toBeGreaterThan(0);
    h.booted.destroy();
  });
});
