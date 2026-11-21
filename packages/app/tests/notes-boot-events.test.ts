// M2.3 接线的另一半：划词/浮动按钮、右栏卡片点击、`doc.changed` 闪烁。
// 夹具在 `support/notes-harness.ts`；这里同样只从 `boot()` 真入口进。

import { describe, expect, it, vi } from "vitest";

import { boot } from "../src/boot.ts";
import { flush, harnessOf } from "./support/boot-harness.ts";
import {
  bootedWith,
  CARD_EVENT,
  draftOf,
  flashCalls,
  notesOf,
  ROOT,
  SELECTION,
  selectOf,
  TEXT,
} from "./support/notes-harness.ts";

describe("批注接线 · 划词", () => {
  it("should record the selection anchor without opening the editor", () => {
    const h = bootedWith();
    selectOf(h, SELECTION);

    expect(h.store.get().noteTarget).toEqual({
      nodeId: "hr-a",
      anchor: {
        exact: TEXT.slice(2, 6),
        prefix: TEXT.slice(0, 2),
        suffix: TEXT.slice(6, 38),
        start: 2,
      },
    });
    expect(h.store.get().noteEditorOpen).toBe(false);
    h.booted.destroy();
  });

  it("should drop a cross-block selection instead of anchoring the wrong block", () => {
    const h = bootedWith();
    selectOf(h, { ...SELECTION, crossBlock: true });

    expect(h.store.get().noteTarget).toBeUndefined();
    expect(h.store.get().noteEditorOpen).toBe(false);
    h.booted.destroy();
  });
});

describe("批注接线 · 浮动按钮", () => {
  it("should open the editor through the floating button", () => {
    const h = bootedWith();
    selectOf(h, SELECTION);
    h.fake.fire(`${ROOT} #hr-note-btn`, "click", {});

    expect(h.store.get().noteEditorOpen).toBe(true);
    h.booted.destroy();
  });

  it("should clear the target through the cancel button", () => {
    const h = bootedWith();
    selectOf(h, SELECTION);
    h.fake.fire(`${ROOT} #hr-note-cancel`, "click", {});

    expect(h.store.get().noteTarget).toBeUndefined();
    expect(h.store.get().noteEditorOpen).toBe(false);
    h.booted.destroy();
  });

  it("should refuse to open the editor when the block has no text", () => {
    const spy = notesOf();
    const h = harnessOf(true);
    const booted = boot({ ...h.deps, notes: { ...spy.notes, textOf: () => undefined } });
    h.type("c");

    expect(h.store.get().noteTarget).toBeUndefined();
    expect(h.store.get().noteEditorOpen).toBe(false);
    booted.destroy();
  });
});

describe("批注接线 · 提交请求", () => {
  it("should POST the drafted note and append the confirmed card", async () => {
    const h = bootedWith();
    selectOf(h, SELECTION);
    h.fake.fire(`${ROOT} #hr-note-btn`, "click", {});

    draftOf(h, "划词批注");
    h.fake.fire(`${ROOT} #hr-note-submit`, "click", {});
    await flush();

    expect(h.posted.map((call) => call.body)).toMatchObject([
      { note: "划词批注", anchor: { exact: TEXT.slice(2, 6), start: 2 } },
    ]);
    expect(h.store.get().annotations.at(-1)?.note).toBe("划词批注");
    h.booted.destroy();
  });
});

/** `foundNodeOf` 走 `host.has`；假 Host 默认不实现，所以这里显式给一个"节点在不在"。 */
const clickable = (has: (selector: string) => boolean) => {
  const h = harnessOf(true);
  const spy = notesOf();
  const booted = boot({ ...h.deps, host: { ...h.deps.host, has }, notes: spy.notes });
  return { ...h, ...spy, booted };
};

describe("批注接线 · 卡片点击", () => {
  it("should scroll to and highlight the card's block", async () => {
    const h = clickable(() => true);
    await flush();
    h.fake.fire(`${ROOT} #hr-notes-body`, "click", CARD_EVENT);
    h.fake.fire(`${ROOT} #hr-notes-pending`, "click", CARD_EVENT);
    h.fake.fire(`${ROOT} #hr-notes-resolved`, "click", CARD_EVENT);

    expect(h.fake.calls).toContainEqual({ op: "scrollTo", args: [`${ROOT} [data-hr-id="hr-a"]`] });
    expect(h.fake.calls.filter((call) => call.op === "scrollTo")).toHaveLength(3);
    expect(h.fake.calls).toContainEqual({
      op: "cls",
      args: [`${ROOT} [data-hr-id="hr-a"]`, "hr-note-target", "1"],
    });
    h.booted.destroy();
  });

  it("should stay put when the block is gone from the DOM", async () => {
    const h = clickable(() => false);
    await flush();
    h.fake.fire(`${ROOT} #hr-notes-body`, "click", CARD_EVENT);

    expect(h.fake.calls.filter((call) => call.op === "scrollTo")).toEqual([]);
    h.booted.destroy();
  });

  it("should swallow a host.has that throws", async () => {
    const h = clickable((selector) => {
      if (selector.includes("data-hr-id")) throw new Error("selector 不合法");
      return true;
    });
    await flush();
    h.fake.fire(`${ROOT} #hr-notes-body`, "click", CARD_EVENT);

    expect(h.fake.calls.filter((call) => call.op === "scrollTo")).toEqual([]);
    h.booted.destroy();
  });
});

describe("批注接线 · 卡片点击的落空", () => {
  it("should not scroll for a card whose anchor is already lost", async () => {
    const h = clickable(() => true);
    await flush();
    h.store.dispatch({
      kind: "annotationsLoaded",
      list: [{ id: "an-1111aaaa", nodeId: "hr-a", note: "x", status: "pending", lost: "orphaned" }],
    });
    h.fake.fire(`${ROOT} #hr-notes-body`, "click", CARD_EVENT);

    expect(h.fake.calls.filter((call) => call.op === "scrollTo")).toEqual([]);
    h.booted.destroy();
  });

  it("should ignore a click that is not on a card", async () => {
    const h = clickable(() => true);
    await flush();
    h.fake.fire(`${ROOT} #hr-notes-body`, "click", { closest: () => null });

    expect(h.fake.calls.filter((call) => call.op === "scrollTo")).toEqual([]);
    h.booted.destroy();
  });
});

describe("doc.changed · 改动块闪烁（默认 schedule）", () => {
  it("should flash a changed block and clear it after 2000ms", () => {
    vi.useFakeTimers();
    try {
      const h = bootedWith();
      h.emit({ id: 1, type: "doc.changed", payload: { changedNodes: ["hr-a"] } });

      expect(flashCalls(h)).toEqual([[`[data-hr-id="hr-a"]`, "hr-flash", "1"]]);

      vi.advanceTimersByTime(1999);
      expect(flashCalls(h)).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(flashCalls(h)).toHaveLength(2);
      expect(flashCalls(h)[1]).toEqual([`[data-hr-id="hr-a"]`, "hr-flash", "0"]);
      h.booted.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("批注接线 · 草稿输入", () => {
  it("should mirror the draft field into the store", () => {
    const h = bootedWith();
    h.fake.fire(`${ROOT} #hr-note-draft`, "input", { value: "草稿" });

    expect(h.store.get().noteDraft).toBe("草稿");
    h.booted.destroy();
  });

  it("should treat an input event without a value as an empty draft", () => {
    const h = bootedWith();
    // `TargetLike.value` 是可选的：没有这个成员时 `event.value ?? ""` 取右边的分支。
    h.fake.fire(`${ROOT} #hr-note-draft`, "input", {});

    expect(h.store.get().noteDraft).toBe("");
    h.booted.destroy();
  });
});
