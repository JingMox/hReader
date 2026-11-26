// 提交批注的真实路径——点模板里的提交按钮，而不是直接 dispatch reducer 的 intent。
// `noteSubmitted` 此前**没有任何 dispatch 点**，所以"乐观卡/防重/失败回滚"三条只能在
// 这个入口上测：从按钮出发，才可能发现"这个 intent 没人发"。

import { describe, expect, it } from "vitest";

import { flush } from "./support/boot-harness.ts";
import {
  bootedWith,
  draftOf,
  hintsOf,
  SELECTION,
  selectOf,
  submitOf,
} from "./support/notes-harness.ts";

const annotationPosts = (h: ReturnType<typeof bootedWith>): readonly string[] =>
  h.posted.filter((post) => post.path.endsWith("/annotations")).map((post) => post.path);

describe("提交批注 · 乐观渲染与防重", () => {
  it("should render the optimistic card immediately and send only one POST", async () => {
    const h = bootedWith({ pendingPost: true });
    // 先等首屏批注落地：`annotationsLoaded` 会把整张清单替换掉，提交必须发生在它之后。
    await flush();
    selectOf(h, SELECTION);
    draftOf(h, "想法");

    submitOf(h);

    // 不 `await flush()`：乐观卡必须在 POST resolve 之前就存在（这才是“立即”）。
    expect(h.store.get().annotations.filter((card) => card.optimistic === true)).toHaveLength(1);
    expect(h.store.get().noteBusy).toBe(true);

    // POST 还挂着：再点一次提交不能变成第二个请求。
    submitOf(h);
    await flush();

    expect(annotationPosts(h)).toHaveLength(1);
    h.booted.destroy();
  });
});

describe("提交批注 · 首屏加载与提交的时序", () => {
  it("should keep the optimistic card when the first annotation list lands after a submit", async () => {
    const h = bootedWith({ pendingPost: true });
    // 故意不等首屏：`annotationsLoaded` 还没落地就提交（用户手快就是这个时序）。
    selectOf(h, SELECTION);
    draftOf(h, "想法");
    submitOf(h);

    await flush();

    // 首屏整表落地后，乐观卡不能被覆盖掉——它是用户刚点下去的东西。
    expect(h.store.get().annotations.filter((card) => card.optimistic === true)).toHaveLength(1);
    expect(h.store.get().annotations.filter((card) => card.note === "想法")).toHaveLength(1);
    h.booted.destroy();
  });
});

describe("提交批注 · 失败提示与回滚", () => {
  it("should show an error and roll the optimistic card back when the POST fails", async () => {
    const h = bootedWith({ failPost: true });
    await flush();
    selectOf(h, SELECTION);
    draftOf(h, "想法");

    submitOf(h);
    expect(h.store.get().annotations.filter((card) => card.optimistic === true)).toHaveLength(1);
    await flush();

    expect(annotationPosts(h)).toHaveLength(1);
    expect(h.store.get().annotations.filter((card) => card.optimistic === true)).toEqual([]);
    expect(h.store.get().noteBusy).toBe(false);
    expect(hintsOf(h).join("")).not.toBe("");
    h.booted.destroy();
  });
});
