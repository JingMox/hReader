// 这层管：G3-R 复核补的接线边角——`notes-wire` 的早退分支、diff 面板的 nodeId 兜底、
// 提交失败的非 Error 路径、`load` 不带 `lost`。全部从 `boot()` 真入口进，不调私有闭包。
import { describe, expect, it, vi } from "vitest";

import { boot } from "../src/boot.ts";
import { flush, harnessOf } from "./support/boot-harness.ts";
import { notesOf, ROOT, SELECTION, shiftD } from "./support/notes-harness.ts";

type Harness = ReturnType<typeof harnessOf>;
type Keyed = Pick<Harness, "keyHandlers">;

const bootWith = (overrides: Parameters<typeof notesOf>[0] = {}) => {
  const h = harnessOf(true);
  const spy = notesOf(overrides);
  const booted = boot({ ...h.deps, notes: spy.notes });
  return { ...h, ...spy, booted };
};

/** Shift+D：`intentOf` 要求 `shiftKey`，而夹具的 `type()` 只传 `key`。 */
const toggleDiff = (h: Keyed): void => {
  for (const handler of h.keyHandlers) handler(shiftD);
};

/** 刻意用非 Error 拒绝：`notes-wire` 的兜底文案不能假设 `reason instanceof Error`。 */
const rejected = (reason: unknown): Promise<never> => {
  const reject = vi.fn<() => Promise<never>>().mockRejectedValue(reason);
  return reject();
};

const activeOn = (store: Harness["store"], id: string): void => {
  store.dispatch({ kind: "blocksLoaded", blocks: [id], outline: [], html: "<p>一</p>" });
};

describe("notes-wire · 空选区", () => {
  it("should ignore a selection that narrows to nothing", () => {
    // `start === end` 是"鼠标点了一下没选中"：既不该开编辑器，也不该给提示——
    // 提示是给"选了但批不了"（跨块）的，点空也弹一条就很吵。
    const h = bootWith();
    const before = h.store.get();
    h.booted.selection?.({ ...SELECTION, start: 2, end: 2 });

    // 同引用 = 一次 dispatch 都没发生（selectors 靠它判“无变化”）。
    expect(h.store.get()).toBe(before);
    expect(h.store.get().noteTarget).toBeUndefined();
    expect(h.store.get().noteEditorOpen).toBe(false);
    h.booted.destroy();
  });
});

describe("notes-wire · diff 的早退", () => {
  it("should fetch the diff when the block has a live card", async () => {
    const h = bootWith();
    await flush();
    activeOn(h.store, "hr-a");
    toggleDiff(h);
    await flush();

    // 对照组：条件都满足时必须真的取一次，并且面板随后才打开（`diffShown` 负责 open）。
    expect(h.fetchDiff).toHaveBeenCalledWith("an-1111aaaa");
    expect(h.store.get().diff.open).toBe(true);
    expect(h.store.get().diff.chunks).toStrictEqual([{ kind: "ins", text: "新段落" }]);
    h.booted.destroy();
  });

  it("should ignore a diff toggle when the surface has no fetchDiff", async () => {
    const base = notesOf();
    const h = harnessOf(true);
    const { fetchDiff, ...withoutDiff } = base.notes;
    expect(fetchDiff).toBeTypeOf("function");
    expect(withoutDiff).not.toHaveProperty("fetchDiff");
    const booted = boot({ ...h.deps, notes: withoutDiff });
    await flush();

    activeOn(h.store, "hr-a");
    toggleDiff(h);
    await flush();

    expect(base.fetchDiff).not.toHaveBeenCalled();
    expect(h.store.get().diff.open).toBe(false);
    booted.destroy();
  });
});

describe("notes-wire · 全部批注都 lost 时不取 diff", () => {
  it("should ignore a diff toggle when every card is lost", async () => {
    const h = bootWith({ lost: ["an-1111aaaa"] });
    await flush();
    activeOn(h.store, "hr-a");
    toggleDiff(h);
    await flush();

    expect(h.fetchDiff).not.toHaveBeenCalled();
    h.booted.destroy();
  });
});

describe("notes-wire · load 不带 lost", () => {
  it("should default lost to an empty list when the server omits it", async () => {
    const base = notesOf();
    const h = harnessOf(true);
    const notes = {
      ...base.notes,
      fetchAnnotations: () => Promise.resolve({ annotations: [] }),
    };
    const booted = boot({ ...h.deps, notes });
    await flush();

    expect(h.store.get().annotations).toStrictEqual([]);
    booted.destroy();
  });
});

describe("notes-wire · 提交失败的两种来源", () => {
  it("should show a fallback message when the rejection is not an Error", async () => {
    const base = notesOf();
    const h = harnessOf(true);
    const notes = {
      ...base.notes,
      io: { ...base.notes.io, post: () => rejected("boom") },
    };
    const booted = boot({ ...h.deps, notes });

    activeOn(h.store, "hr-a");
    h.fake.fire(`${ROOT} #hr-root [data-hr-id="hr-a"]`, "click", {});
    h.type("c");
    h.store.dispatch({ kind: "noteChanged", text: "我的批注" });
    h.fake.fire(`${ROOT} #hr-note-submit`, "click", {});
    await flush();

    expect(h.store.get().noteError).toBe("提交失败");
    booted.destroy();
  });

  it("should not POST when the draft is blank", async () => {
    const h = bootWith();
    activeOn(h.store, "hr-a");
    h.type("c");
    h.store.dispatch({ kind: "noteChanged", text: "   " });
    h.fake.fire(`${ROOT} #hr-note-submit`, "click", {});
    await flush();

    expect(h.posted).toStrictEqual([]);
    h.booted.destroy();
  });
});
