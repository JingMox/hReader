// 这层管：`notes-state.ts` 的状态迁移表——每个 intent 的落态 + "同引用=无变化"的约定。
// 全纯函数，不需要 DOM/Host；`boot` 的接线另在 `notes-boot.test.ts`。

import { describe, expect, it } from "vitest";

import {
  closedDiff,
  optimisticCardOf,
  type AnnotationCard,
  type NoteAnchor,
} from "../src/notes.ts";
import {
  initialNoteSlice,
  isDiffIntent,
  isNoteIntent,
  reduceDiff,
  reduceNote,
  withLost,
  type NoteSlice,
} from "../src/notes-state.ts";

const ANCHOR: NoteAnchor = { exact: "正文", prefix: "", suffix: "", start: 3 };

const CARD: AnnotationCard = {
  id: "an-1",
  nodeId: "hr-b",
  note: "好",
  status: "pending",
};

const sliceOf = (patch: Partial<NoteSlice> = {}): NoteSlice => ({
  ...initialNoteSlice,
  ...patch,
});

const target = { nodeId: "hr-b", anchor: ANCHOR };

/** 成功收尾：`noteSettled` 没有 `card` 字段（真卡由随后的 `annotationsLoaded` 落地）。 */
const confirming = (state: NoteSlice): NoteSlice =>
  reduceNote(state, { kind: "noteSettled", ok: true });

describe("notes-state · 类型守卫", () => {
  it("should recognise every note kind and reject a diff kind", () => {
    for (const kind of [
      "annotateStart",
      "selectionMade",
      "annotateButton",
      "annotateCancel",
      "noteChanged",
      "noteSubmitted",
      "noteSettled",
      "annotationsLoaded",
      "annotationOpened",
    ]) {
      expect(isNoteIntent({ kind })).toBe(true);
    }
    expect(isNoteIntent({ kind: "diffToggled" })).toBe(false);
    expect(isNoteIntent({ kind: "move" })).toBe(false);
  });

  it("should recognise every diff kind and reject a note kind", () => {
    for (const kind of ["diffToggled", "diffShown", "revert"]) {
      expect(isDiffIntent({ kind })).toBe(true);
    }
    expect(isDiffIntent({ kind: "noteChanged" })).toBe(false);
    expect(isDiffIntent({ kind: "diffAccepted" })).toBe(false);
  });
});

describe("notes-state · withLost", () => {
  it("should mark only the lost ids and keep cards untouched elsewhere", () => {
    const marked = withLost([CARD, { ...CARD, id: "an-2" }], ["an-2"]);

    expect(marked[0]).toBe(CARD);
    expect(marked[1]).toEqual({ ...CARD, id: "an-2", lost: "anchor_lost" });
  });

  it("should not overwrite an existing lost reason", () => {
    const orphaned: AnnotationCard = { ...CARD, lost: "orphaned" };

    expect(withLost([orphaned], ["an-1"])[0]).toBe(orphaned);
  });
});

describe("notes-state · 选区与编辑框", () => {
  it("should open the editor on annotateStart and clear a foreign draft", () => {
    const state = sliceOf({ noteDraft: "旧草稿", noteError: "旧错误" });
    const next = reduceNote(state, { kind: "annotateStart", ...target });

    expect(next).toMatchObject({ noteTarget: target, noteDraft: "", noteError: undefined });
    expect(next.noteEditorOpen).toBe(true);
  });

  it("should keep the draft when annotateStart hits the same anchor", () => {
    const state = sliceOf({ noteTarget: target, noteDraft: "草稿" });

    expect(reduceNote(state, { kind: "annotateStart", ...target }).noteDraft).toBe("草稿");
  });
});

describe("notes-state · 选区与面板", () => {
  it("should record a selection without opening the editor", () => {
    const next = reduceNote(initialNoteSlice, { kind: "selectionMade", ...target });

    expect(next).toMatchObject({ noteTarget: target, noteEditorOpen: false });
  });

  it("should return the same slice for a repeated selection", () => {
    const state = reduceNote(initialNoteSlice, { kind: "selectionMade", ...target });

    expect(reduceNote(state, { kind: "selectionMade", ...target })).toBe(state);
  });

  it("should open and cancel the panel with its own guards", () => {
    const selected = reduceNote(initialNoteSlice, { kind: "selectionMade", ...target });
    const opened = reduceNote(selected, { kind: "annotateButton" });

    expect(opened.noteEditorOpen).toBe(true);
    expect(reduceNote(opened, { kind: "annotateButton" })).toBe(opened);
    expect(reduceNote(initialNoteSlice, { kind: "annotateButton" })).toBe(initialNoteSlice);
    expect(reduceNote(opened, { kind: "annotateCancel" })).toMatchObject({
      noteTarget: undefined,
      noteDraft: "",
      noteEditorOpen: false,
    });
    expect(reduceNote(initialNoteSlice, { kind: "annotateCancel" })).toBe(initialNoteSlice);
  });

  it("should keep an annotationOpened as a pure no-op", () => {
    expect(reduceNote(initialNoteSlice, { kind: "annotationOpened", id: "an-1" })).toBe(
      initialNoteSlice,
    );
  });
});

describe("notes-state · 草稿", () => {
  it("should ignore a noteChanged with the same text", () => {
    const typed = reduceNote(initialNoteSlice, { kind: "noteChanged", text: "a" });

    expect(typed.noteDraft).toBe("a");
    expect(reduceNote(typed, { kind: "noteChanged", text: "a" })).toBe(typed);
  });
});

describe("notes-state · 提交与回滚", () => {
  it("should append an optimistic card, bump the seq and close the editor", () => {
    const state = sliceOf({ noteTarget: target, noteDraft: "好", noteEditorOpen: true });
    const card = optimisticCardOf(target, "好", 0);
    const next = reduceNote(state, { kind: "noteSubmitted", card });

    expect(next).toMatchObject({
      annotations: [card],
      noteTarget: undefined,
      noteDraft: "",
      noteEditorOpen: false,
      noteBusy: true,
      noteSeq: 1,
    });
  });
});

// 乐观卡的生命周期和"失败回滚"分开一个 `describe`：成功路径**不**转正、失败路径**删**卡，
// 两件事混在一起容易让 `max-lines-per-function` 顶到上限，也容易读错。
describe("notes-state · 乐观卡与 reload", () => {
  it("should keep the optimistic card until reload brings the real one", () => {
    const submitted = reduceNote(sliceOf({ noteTarget: target }), {
      kind: "noteSubmitted",
      card: optimisticCardOf(target, "好", 0),
    });
    const settled = confirming(submitted);

    // 成功只结束“提交中”：真卡由随后的 reload 落地。先转正的话，那张 `tmp-*` 卡既删不掉
    // （已不属未确认），点它还必然 404 —— 所以这里断言它**仍在**，且 reload 后被真卡顶掉。
    expect(settled.noteBusy).toBe(false);
    expect(settled.noteError).toBeUndefined();
    expect(settled.annotations.map((card) => card.id)).toEqual(["tmp-0"]);

    const reloaded = reduceNote(settled, { kind: "annotationsLoaded", list: [CARD] });

    expect(reloaded.annotations).toEqual([CARD]);
  });
});

describe("notes-state · 确认与失败", () => {
  it("should roll back only the optimistic card and keep the message", () => {
    const submitted = reduceNote(sliceOf({ annotations: [CARD], noteTarget: target }), {
      kind: "noteSubmitted",
      card: { ...CARD, id: "tmp-0", optimistic: true },
    });
    const next = reduceNote(submitted, { kind: "noteSettled", ok: false, message: "409: locked" });

    expect(next.annotations).toEqual([CARD]);
    expect(next.noteBusy).toBe(false);
    expect(next.noteError).toBe("409: locked");
  });

  it("should clear 提交中 without inventing an error when ok=true carries no card", () => {
    const next = reduceNote(sliceOf({ noteBusy: true }), { kind: "noteSettled", ok: true });

    // 成功路径不产生错误：真卡走 reload，`noteSettled` 只负责摘掉“提交中”。
    expect(next.noteError).toBeUndefined();
    expect(next.noteBusy).toBe(false);
  });

  it("should keep the same slice when the same message is reported twice", () => {
    // 同一条提示重复上报（例如连续两次划到同一个跨块选区）不该触发一次重渲染：
    // 引用相等是 `state.ts` 与订阅方约定的“无变化”。
    const first = reduceNote(initialNoteSlice, { kind: "noteError", message: "跨块选区不支持" });
    const second = reduceNote(first, { kind: "noteError", message: "跨块选区不支持" });
    const other = reduceNote(second, { kind: "noteError", message: "换一句话" });

    expect(second).toBe(first);
    expect(other.noteError).toBe("换一句话");
  });

  it("should fall back to 提交失败 when a failure carries no message", () => {
    const next = reduceNote(sliceOf({ noteBusy: true }), { kind: "noteSettled", ok: false });

    expect(next.noteError).toBe("提交失败");
  });
});

describe("notes-state · 列表加载", () => {
  it("should adopt a fresh list and ignore the identical one", () => {
    const list: readonly AnnotationCard[] = [CARD];
    const loaded = reduceNote(initialNoteSlice, { kind: "annotationsLoaded", list });

    expect(loaded.annotations).toBe(list);
    expect(reduceNote(loaded, { kind: "annotationsLoaded", list })).toBe(loaded);
  });
});

describe("notes-state · diff 切片", () => {
  it("should open the panel with the computed chunks", () => {
    const next = reduceDiff(
      { diff: closedDiff },
      { kind: "diffShown", nodeId: "hr-b", chunks: [{ kind: "ins", text: "x" }], degraded: true },
    );

    expect(next.diff).toEqual({
      open: true,
      nodeId: "hr-b",
      chunks: [{ kind: "ins", text: "x" }],
      degraded: true,
    });
  });

  it("should carry the server's degraded reason into the slice", () => {
    // `reason` 是给用户看的那句话（`diffStatusOf` 直接显示它）；丢了就只剩默认的“内容较长”。
    const next = reduceDiff(
      { diff: closedDiff },
      {
        kind: "diffShown",
        nodeId: "hr-b",
        chunks: [],
        degraded: true,
        reason: "该块 ID 已随内容变化重建，按位置重新识别",
      },
    );

    expect(next.diff.reason).toBe("该块 ID 已随内容变化重建，按位置重新识别");
    expect(next.diff.degraded).toBe(true);
  });
});

describe("notes-state · diff 切片的开关", () => {
  it("should close on toggle only while open", () => {
    const open = reduceDiff(
      { diff: closedDiff },
      { kind: "diffShown", nodeId: "hr-b", chunks: [], degraded: false },
    );
    const closed = reduceDiff(open, { kind: "diffToggled" });

    expect(closed.diff).toBe(closedDiff);
    expect(reduceDiff(closed, { kind: "diffToggled" })).toBe(closed);
  });

  it("should treat revert as a no-op here (store does the work)", () => {
    const state = { diff: closedDiff };

    expect(reduceDiff(state, { kind: "revert" })).toBe(state);
  });
});
