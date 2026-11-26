// 撤销（`w`）之后面板必须关、状态必须落，否则连按 `w` 会连撤——
// 第二下撤掉的是用户自己刚做的 patch（实测的损失路径）。

import { describe, expect, it } from "vitest";

import { flush } from "./support/boot-harness.ts";
import { bootedWith, shiftD } from "./support/notes-harness.ts";

const undoPosts = (h: ReturnType<typeof bootedWith>): readonly string[] =>
  h.posted.filter((post) => post.path.endsWith("/undo")).map((post) => post.path);

const openDiff = async (h: ReturnType<typeof bootedWith>): Promise<void> => {
  // 先等首屏批注落地：`diffFlow` 要按 activeId 找到对应批注才发请求。
  await flush();
  h.keyHandlers[0]?.(shiftD);
  await flush();
};

describe("撤销 · 面板关闭与单次请求", () => {
  it("should close the diff panel after a revert", async () => {
    const h = bootedWith();
    await openDiff(h);
    expect(h.store.get().diff.open).toBe(true);

    h.keyHandlers[0]?.({ key: "w" });
    await flush();

    expect(h.store.get().diff.open).toBe(false);
    h.booted.destroy();
  });

  it("should send only one undo when w is pressed twice", async () => {
    const h = bootedWith();
    await openDiff(h);

    h.keyHandlers[0]?.({ key: "w" });
    h.keyHandlers[0]?.({ key: "w" });
    await flush();

    expect(undoPosts(h)).toHaveLength(1);
    h.booted.destroy();
  });
});
