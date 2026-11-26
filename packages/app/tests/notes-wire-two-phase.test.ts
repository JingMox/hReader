// 这层测：`wireNotes` 的两相出口（`before` 守卫 / `after` 副作用）本身——
// 直接拿 `wireNotes` 的返回对象与一个空 store，不经过 `boot()` 的按键路由。
// 两相必须能分开调，否则测不出"守卫读到 dispatch 之后的状态"。
import { describe, expect, it } from "vitest";

import { initialState } from "../src/state.ts";
import { createStore } from "../src/store.ts";
import { wireNotes } from "../src/notes-wire.ts";
import { harnessOf } from "./support/boot-harness.ts";
import { notesOf, ROOT } from "./support/notes-harness.ts";

/** `wireNotes` 的依赖：模块级小工厂，避免每个用例背后拖一条 50 行的箭头函数。 */
const depsOf = (
  h: ReturnType<typeof harnessOf>,
  spy: ReturnType<typeof notesOf>,
  store: ReturnType<typeof createStore>,
  pending: Promise<void>[],
): Parameters<typeof wireNotes>[0] => ({
  host: h.fake.host,
  notes: spy.notes,
  reload: () => {
    pending.push(Promise.resolve());
    return Promise.resolve();
  },
  store,
  pump: (task) => {
    pending.push(task());
  },
  dispatch: (intent) => {
    store.dispatch(intent);
  },
});

const scopeOf = () => {
  const h = harnessOf(true);
  const spy = notesOf();
  const store = createStore(initialState("doc.html", "atelier-editorial"));
  const pending: Promise<void>[] = [];
  const wire = wireNotes(depsOf(h, spy, store, pending));
  return { h, spy, store, wire, pending };
};

describe("wireNotes · after 的两相副作用", () => {
  it("should skip the sidenote when there is no active block", () => {
    const { store, wire } = scopeOf();

    wire.after({ kind: "openSidenote", id: "hr-a" });

    expect(store.get().noteEditorOpen).toBe(false);
    expect(store.get().noteTarget).toBeUndefined();
  });

  it("should skip the diff load when there is no active block", () => {
    const { spy, store, wire } = scopeOf();
    store.dispatch({ kind: "diffToggled" });

    wire.after({ kind: "diffToggled" });

    expect(spy.fetchDiff).not.toHaveBeenCalled();
  });

  it("should skip the diff load when the card for the block is lost", () => {
    const { spy, store, wire } = scopeOf();
    store.dispatch({ kind: "blocksLoaded", blocks: ["hr-a"], outline: [], html: "<p>一</p>" });
    store.dispatch({
      kind: "annotationsLoaded",
      list: [{ id: "an-1", nodeId: "hr-a", note: "n", status: "pending", lost: "orphaned" }],
    });
    store.dispatch({ kind: "diffToggled" });

    wire.after({ kind: "diffToggled" });

    expect(spy.fetchDiff).not.toHaveBeenCalled();
  });
});

describe("wireNotes · after 的早退（无 fetchDiff）", () => {
  it("should skip the diff load when the surface cannot fetch", () => {
    const { h, store } = scopeOf();
    const base = notesOf();
    const { fetchDiff, ...withoutDiff } = base.notes;
    expect(fetchDiff).toBeTypeOf("function");
    expect(withoutDiff).not.toHaveProperty("fetchDiff");
    const wire = wireNotes({
      host: h.fake.host,
      notes: withoutDiff,
      reload: () => Promise.resolve(),
      store,
      pump: (task) => {
        void task();
      },
      dispatch: (intent) => {
        store.dispatch(intent);
      },
    });
    store.dispatch({ kind: "blocksLoaded", blocks: ["hr-a"], outline: [], html: "<p>一</p>" });
    store.dispatch({ kind: "diffToggled" });

    expect(() => {
      wire.after({ kind: "diffToggled" });
    }).not.toThrow();
    expect(store.get().diff.chunks).toStrictEqual([]);
  });
});

describe("wireNotes · before 守卫只看 dispatch 前的状态", () => {
  it("should refuse w while the diff panel is closed and allow it after it opens", () => {
    const { store, wire } = scopeOf();

    // 面板只在 diff 真的取回来之后才 `open`（`reduceDiff` 的 `diffToggled` 只负责关）。
    expect(wire.before({ kind: "revert" })).toBe(false);
    store.dispatch({ kind: "diffShown", nodeId: "hr-a", chunks: [], degraded: false });
    expect(wire.before({ kind: "revert" })).toBe(true);
  });

  it("should not gate any other intent", () => {
    const { wire } = scopeOf();

    expect(wire.before({ kind: "openSidenote", id: "hr-a" })).toBe(true);
    expect(wire.before({ kind: "diffToggled" })).toBe(true);
  });
});

describe("wireNotes · 选区入口", () => {
  it("should dispatch a selectionMade for a same-block selection", () => {
    const { store, wire } = scopeOf();

    wire.selection({ nodeId: "hr-a", blockText: "abcdef", start: 1, end: 3, crossBlock: false });

    expect(store.get().noteTarget).toStrictEqual({
      nodeId: "hr-a",
      anchor: { exact: "bc", prefix: "a", suffix: "def", start: 1 },
    });
  });

  it("should drop a cross-block selection", () => {
    const { store, wire } = scopeOf();

    wire.selection({ nodeId: "hr-a", blockText: "abcdef", start: 1, end: 3, crossBlock: true });

    expect(store.get().noteTarget).toBeUndefined();
  });
});

describe("wireNotes · DOM 接线", () => {
  it("should bind the submit button and the card clicks", () => {
    const { h, wire } = scopeOf();
    wire.wireDom();

    const selectors = h.fake.calls.filter((call) => call.op === "on").map((call) => call.args[0]);

    expect(selectors).toContain(`${ROOT} #hr-note-submit`);
  });
});

describe("wireNotes · 提交不带锚点时省略 anchor 字段", () => {
  it("should POST without an anchor key when no selection is active", async () => {
    const { spy, store, wire, pending } = scopeOf();
    store.dispatch({ kind: "blocksLoaded", blocks: ["hr-a"], outline: [], html: "<p>一</p>" });
    // 直接提交一张卡（没有经过 c 键/划词）：载荷里就不能冒出 `anchor: undefined`。
    wire.submit({ id: "an-2", nodeId: "hr-a", note: "n", status: "pending" });
    await Promise.all(pending);

    expect(spy.posted).toHaveLength(1);
    // 载荷只有 `nodeId`/`note`：`anchor` 键根本不该存在（乐观卡由 `wireSubmit` 发，不归 `submit` 管）。
    expect(Object.keys(spy.posted[0]?.body ?? {}).sort()).toEqual(["nodeId", "note"]);
    expect(spy.posted[0]?.path).toBe("/api/doc/doc.html/annotations");
  });
});
