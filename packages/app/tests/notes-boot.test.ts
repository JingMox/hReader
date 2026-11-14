// 这层管：M2.3 的 UI 端到端接线（§10.7）——从 `boot()` 的真入口进，
// 走真 `dispatchIntent` 路由，断言"按键 → 状态 → POST → 右栏"整条链，
// 不在中间层直接调 `submitFlow` / `settleTheme` / `store.dispatch`。
// 划词、卡片点击、闪烁在 `notes-boot-events.test.ts`（同一夹具）。

import { describe, expect, it } from "vitest";

import { flush } from "./support/boot-harness.ts";
import { bootedWith, draftOf, pendingWrites, ROOT, shiftD, TEXT } from "./support/notes-harness.ts";

describe("批注接线 · c 键到 POST 到右栏", () => {
  it("should load the server list once at boot and render it", async () => {
    const h = bootedWith();
    await flush();

    expect(h.fetchAnnotations).toHaveBeenCalledTimes(1);
    expect(h.store.get().annotations).toHaveLength(1);
    expect(pendingWrites(h).at(-1)).toContain("服务端已有");
    h.booted.destroy();
  });

  it("should turn the c key into a whole-block selection and open the editor", () => {
    const h = bootedWith();
    h.type("c");

    expect(h.store.get().noteTarget).toEqual({
      nodeId: "hr-a",
      anchor: { exact: TEXT, prefix: "", suffix: "", start: 0 },
    });
    expect(h.store.get().noteEditorOpen).toBe(true);
    h.booted.destroy();
  });
});

describe("批注接线 · 提交与失败回滚", () => {
  it("should POST the c-key selection exactly once and confirm the card", async () => {
    const h = bootedWith();
    h.type("c");
    draftOf(h, "我的批注");
    h.fake.fire(`${ROOT} #hr-note-submit`, "click", {});
    await flush();

    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]?.path).toBe("/api/doc/doc.html/annotations");
    expect(h.posted[0]?.body).toMatchObject({
      nodeId: "hr-a",
      note: "我的批注",
      anchor: { exact: TEXT },
    });
    expect(h.store.get().annotations.map((card) => card.note)).toEqual(["服务端已有", "我的批注"]);
    expect(pendingWrites(h).at(-1)).toContain("我的批注");
    h.booted.destroy();
  });

  it("should roll the optimistic card back and surface the message when POST fails", async () => {
    const h = bootedWith({ failPost: true });
    h.type("c");
    draftOf(h, "会失败的批注");
    h.fake.fire(`${ROOT} #hr-note-submit`, "click", {});
    await flush();

    expect(h.posted).toHaveLength(1);
    expect(h.store.get().annotations.map((card) => card.note)).toEqual(["服务端已有"]);
    expect(h.store.get().noteError).toBe("boom");
    expect(pendingWrites(h).at(-1)).not.toContain("会失败的批注");
    h.booted.destroy();
  });
});

describe("diff 接线 · Shift+D", () => {
  it("should compute the diff from the injected text sources on Shift+D", async () => {
    const h = bootedWith();
    await flush();
    h.keyHandlers[0]?.(shiftD);
    await flush();

    expect(h.fetchDiff.mock.calls).toEqual([["an-1111aaaa"]]);
    expect(h.store.get().diff).toEqual({
      open: true,
      nodeId: "hr-a",
      chunks: [{ kind: "ins", text: "新段落" }],
      degraded: false,
    });
    expect(
      h.fake.calls.filter(
        (call) => call.op === "children" && call.args[0] === `${ROOT} #hr-diff-chunks`,
      ),
    ).toHaveLength(1);
    h.booted.destroy();
  });
});

describe("diff 接线 · w 的守卫与撤销", () => {
  it("should let w revert only while the diff is open", async () => {
    const h = bootedWith();
    await flush();
    h.type("w");
    await flush();
    expect(h.posted).toEqual([]);

    h.keyHandlers[0]?.(shiftD);
    await flush();
    expect(h.store.get().diff.open).toBe(true);
    h.type("w");
    await flush();

    expect(h.posted.map((call) => call.path)).toEqual(["/api/doc/doc.html/undo"]);
    // 撤销成功即面板关闭（P1-10）：不关的话再按一次 `w` 会再撤一次，可能把用户刚做的 patch 撤掉。
    expect(h.store.get().diff.open).toBe(false);
    h.booted.destroy();
  });
});
