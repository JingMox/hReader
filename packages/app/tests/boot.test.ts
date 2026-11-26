// 这层管：`boot` 的接线契约——状态 → widget 更新、SSE 事件 → 串行刷新、键盘 → intent、
// 主题选择 → IO + 落定；用假 Host / 假 Sse / 假时钟泵，全部在调用序列上断言。

import { describe, expect, it } from "vitest";

import { boot, settleTheme } from "../src/boot.ts";
import { intentOf } from "../src/keys.ts";
import { COPY } from "../src/widgets/copy.ts";

const ROOT = "#hr-root";
import type { BootDeps, Harness, ReaderIntent } from "./support/boot-harness.ts";
import {
  blocksOf,
  captureUnhandled,
  countingStore,
  flush,
  harnessOf,
  recordingStore,
} from "./support/boot-harness.ts";

describe("boot · 首屏与 widget 更新", () => {
  it("should mount the four widgets and inject the document HTML once", () => {
    const h = harnessOf(true);
    const booted = boot(h.deps);
    expect(h.fake.calls.filter((call) => call.op === "html")).toHaveLength(1);
    expect(h.fake.calls.some((call) => call.op === "children")).toBe(true);
    booted.destroy();
    expect(h.closed()).toBe(true);
    expect(h.fake.ops().at(-1)).toBe("destroy");
  });

  it("should refresh only on doc.changed / doc.reloaded and drop unrelated events", async () => {
    const h = harnessOf(true);
    boot(h.deps);
    h.emit({ id: 1, type: "library.changed", payload: {} });
    h.emit({ id: 2, type: "doc.changed", payload: {} });
    await flush();
    h.emit({ id: 3, type: "doc.reloaded", payload: {} });
    await flush();
    expect(h.fetched.document).toBe(2);
    expect(h.store.get().revision).toBe("r1");
    expect(blocksOf(h.store.get())).toEqual(["hr-a"]);
  });

  it("should coalesce back-to-back doc.changed events into a single reload", async () => {
    // 泵上的任务是微任务：两条同步事件之间不会有任务起跑——后一条落在"已排队"段，
    // 被合并掉。不合并的话补丁连发会积成全量重取串，高负载下拖过等待上限。
    const h = harnessOf(true);
    boot(h.deps);
    h.emit({ id: 1, type: "doc.changed", payload: {} });
    h.emit({ id: 2, type: "doc.changed", payload: {} });
    await flush();
    expect(h.fetched.document).toBe(1);
  });

  it("should refresh with an empty block list when the model omits children", async () => {
    const h = harnessOf(true);
    boot({ ...h.deps, fetchModel: () => Promise.resolve({ revision: "r9", model: {} }) });
    h.emit({ id: 1, type: "doc.changed", payload: {} });
    await flush();
    expect(blocksOf(h.store.get())).toEqual([]);
    expect(h.store.get().revision).toBe("r9");
  });
});

describe("boot · 键盘与主题", () => {
  it("should dispatch plain intents and ignore unknown keys", () => {
    const h = harnessOf(true);
    boot(h.deps);
    h.type("j");
    h.type("h");
    h.type("/");
    h.type("z");
    expect(h.store.get().focus).toBe(true);
    expect(h.store.get().searchOpen).toBe(true);
    h.type("Escape");
    expect(h.store.get().panel).toBe("closed");
  });
});

describe("boot · widget intent → store", () => {
  it("should dispatch a widget intent into the shared store", () => {
    const h = harnessOf(true);
    boot(h.deps);
    h.fake.fire(`${ROOT} #hr-theme-select`, "change", { value: "manuscript" });
    expect(h.store.get().themeRequested).toBe("manuscript");
    // 已知缺陷：widget 的 intent 只进 store，没接到 `themeSwitcher`，
    // 所以 `style.select` 一次也不会被叫（此前主题切换是死的；现在走 `dispatchIntent`，见 main-inject 的主题接线用例）。
    expect(h.selectCalls).toEqual([]);
  });
});

describe("boot · 键盘 intent 的出口（经 keyHandlerOf，不绕过它）", () => {
  it("should press / and write the deferred hint instead of focusing the disabled search box", () => {
    const h = harnessOf(true);
    boot(h.deps);

    h.keyHandlers[0]?.({ key: "/" });

    // `searchOpened` 的唯一副作用：把"搜索还没接线"写进状态栏提示（`boot.ts:272`）。
    // 搜索框在模板里是 `disabled`——聚焦一个点不动的控件比没有更糟，所以按键路径不能聚焦它。
    const hints = h.fake.calls
      .filter((call) => call.op === "text" && call.args[0] === `${ROOT} #hr-hint`)
      .map((call) => call.args[1]);
    expect(hints.at(-1)).toBe(COPY.searchDeferred);
    // 空串写进去等于没提示：文案本身必须非空。
    expect(COPY.searchDeferred.length).toBeGreaterThan(0);
    // “没聚焦”由上面两条（写进 `#hr-hint` 的文案 + 非空）证明：`focus` op 已移除
    // 从 `Host` 上删除，`ops()` 结构上再也不可能含 `"focus"`，留着那条断言只会恒真。
    // 同一个 if 链的 false 臂：`/` 不是 scrollTo。
    expect(h.fake.ops()).not.toContain("scrollTo");
    // 同一句文案也挂在 `title` 上（`boot.ts:276`），鼠标悬停时同样能读到延期原因。
    expect(
      h.fake.calls.filter(
        (call) =>
          call.op === "attr" && call.args[0] === `${ROOT} #hr-search` && call.args[1] === "title",
      ),
    ).toEqual([{ op: "attr", args: [`${ROOT} #hr-search`, "title", COPY.searchDeferred] }]);
  });

  it("should press j and not scroll", () => {
    const h = harnessOf(true);
    boot(h.deps);

    h.keyHandlers[0]?.({ key: "j" });

    // `move` 走 store，不碰 host 唯一剩下的副作用出口 `scrollTo`（`focus` 已移除）。
    expect(h.fake.ops()).not.toContain("scrollTo");
    // 只有一个块：`j` 到顶后仍停在同一块（不越界、不抛）。
    expect(h.store.get().activeId).toBe("hr-a");
  });
});

describe("boot · 键路由的意图集合（boot.ts:133 为何是死分支）", () => {
  it("should never route a key to the scrollTo effect", () => {
    const state = harnessOf(true).store.get();
    const keys = ["j", "k", "h", "/", "c", "Escape", "x", "Enter"];

    // `intentOf` 是 `keyHandlerOf` 唯一的意图来源；它产的 kind 里没有 `scrollTo`，
    // 所以 `boot.ts:133` 的 scrollTo 副作用对键盘路径结构性不可达。
    expect(keys.map((key) => intentOf({ key }, state)?.kind ?? "none")).toEqual([
      "move",
      "move",
      "toggleFocus",
      "searchOpened",
      "none",
      "panelClosed",
      "none",
      "none",
    ]);
  });
});

describe("boot · 主题落定与回滚", () => {
  it("should keep the applied theme and roll themeRequested back when the load fails", async () => {
    const h = harnessOf(false);
    boot(h.deps);
    await flush();
    h.store.dispatch({ kind: "themeSelected", theme: "manuscript" });
    expect(h.store.get().themeRequested).toBe("manuscript");
    h.store.dispatch({ kind: "themeSettled", theme: "manuscript", ok: false });
    expect(h.store.get().theme).toBe("atelier-editorial");
    expect(h.store.get().themeRequested).toBe("atelier-editorial");
  });
});

describe("boot · destroy 与串行泵", () => {
  it("should unbind keys, unsubscribe and close the sse", () => {
    const h = harnessOf(true);
    const counted = countingStore(h.store);
    boot({ ...h.deps, store: counted.store }).destroy();
    expect(h.keysBound()).toBe(0);
    expect(counted.counts.subscribe).toBe(1);
    expect(counted.counts.off).toBe(1);
    expect(h.closed()).toBe(true);
  });

  // 已知缺陷（src 侧）：`createPump` 的 `tail.then(task, task)` 没有 `catch`，
  // 刷新失败会成为 unhandledRejection（浏览器控制台报错）；泵本身仍能继续跑下一轮。
  it("should keep serving the next refresh after a rejection (and surface it)", async () => {
    const caught = captureUnhandled();
    const h = harnessOf(true);
    const counters = { calls: 0 };
    const deps: BootDeps = {
      ...h.deps,
      fetchDocument: () => {
        counters.calls += 1;
        return counters.calls === 1
          ? Promise.reject(new Error("boom"))
          : Promise.resolve("<p>三</p>");
      },
    };
    const intents: ReaderIntent[] = [];
    boot({ ...deps, store: recordingStore(h.store, intents) });
    h.emit({ id: 1, type: "doc.changed", payload: {} });
    await flush();
    h.emit({ id: 2, type: "doc.changed", payload: {} });
    await flush();
    await flush();
    caught.stop();
    expect(counters.calls).toBe(2);
    expect(intents.filter((intent) => intent.kind === "documentChanged").length).toBeGreaterThan(0);
    expect(caught.seen).toHaveLength(1);
  });
});

describe("boot · 首屏主题失败不回退", () => {
  it("should keep the old theme when the first theme fails to load", async () => {
    const h = harnessOf(false);
    const booted = boot(h.deps);
    await flush();
    expect(h.selectCalls.length).toBe(1);
    expect(h.store.get().theme).toBe("atelier-editorial");
    booted.destroy();
  });
});

describe("boot · settleTheme 的两个结局", () => {
  it("should apply the theme and mark it settled when the switch succeeds", async () => {
    const h = harnessOf(true);
    const ok = await settleTheme(h.deps, { theme: "manuscript", previous: "atelier-editorial" });

    expect(ok).toBe(true);
    expect(h.selectCalls).toEqual([{ theme: "manuscript", current: "atelier-editorial" }]);
  });

  it("should report failed and keep the previous theme when the CSS cannot load", async () => {
    const h = harnessOf(false);
    const ok = await settleTheme(h.deps, { theme: "manuscript", previous: "atelier-editorial" });

    expect(ok).toBe(false);
    expect(h.selectCalls).toEqual([{ theme: "manuscript", current: "atelier-editorial" }]);
  });
});

describe("boot · 服务器没给任何主题", () => {
  it("should skip the first theme entirely when the list is empty", () => {
    const h = harnessOf(true);
    const booted = boot({ ...h.deps, themes: [] });
    expect(h.selectCalls).toEqual([]);
    booted.destroy();
    expect(h.fake.ops().at(-1)).toBe("destroy");
  });

  it("should fall back to the first list entry when defaultTheme is omitted", async () => {
    const h = harnessOf(true);
    const booted = boot({ ...h.deps, themes: ["manuscript"] });
    await flush();
    expect(h.selectCalls).toEqual([{ theme: "manuscript", current: "manuscript" }]);
    booted.destroy();
  });
});

describe("boot · 沉浸模式", () => {
  const immersiveAttrs = (h: Harness): readonly string[] =>
    h.fake.calls
      .filter(
        (call) =>
          call.op === "attr" && call.args[0] === ROOT && call.args[1] === "data-hr-immersive",
      )
      .map((call) => call.args[2] ?? "<removed>");

  it("should flip data-hr-immersive through i, the statusbar button and Escape", () => {
    const h = harnessOf(true);
    boot(h.deps);
    expect(immersiveAttrs(h).at(-1)).toBe("<removed>");

    h.type("i");
    expect(h.store.get().immersive).toBe(true);
    expect(immersiveAttrs(h).at(-1)).toBe("");

    // 底栏按钮与快捷键同一个出口：再点一次退出沉浸。
    h.fake.fire(`${ROOT} #hr-immersive-btn`, "click", {});
    expect(h.store.get().immersive).toBe(false);
    expect(immersiveAttrs(h).at(-1)).toBe("<removed>");

    h.fake.fire(`${ROOT} #hr-immersive-btn`, "click", {});
    expect(h.store.get().immersive).toBe(true);
    h.type("Escape");
    expect(h.store.get().immersive).toBe(false);
    expect(immersiveAttrs(h).at(-1)).toBe("<removed>");
  });

  it("should paint the immersive button label and hint at mount", () => {
    const h = harnessOf(true);
    boot(h.deps);

    const texts = h.fake.calls
      .filter((call) => call.op === "text" && call.args[0] === `${ROOT} #hr-immersive-btn`)
      .map((call) => call.args[1]);
    const titles = h.fake.calls
      .filter(
        (call) =>
          call.op === "attr" &&
          call.args[0] === `${ROOT} #hr-immersive-btn` &&
          call.args[1] === "title",
      )
      .map((call) => call.args[2]);
    expect(texts).toEqual([COPY.immersive]);
    expect(titles).toEqual([COPY.immersiveHint]);
  });

  // 兜底出口：iframe 吃掉 Esc/i 时（焦点在 iframe 里，壳收不到 keydown），
  // 顶边热区浮出的按钮是唯一的退出通道——它必须发出同一个 immersiveToggled。
  it("should exit immersive through the edge button when the frame ate the keys", () => {
    const h = harnessOf(true);
    boot(h.deps);
    h.type("i");
    expect(h.store.get().immersive).toBe(true);
    expect(immersiveAttrs(h).at(-1)).toBe("");

    h.fake.fire(`${ROOT} #hr-immersive-exit`, "click", {});
    expect(h.store.get().immersive).toBe(false);
    expect(immersiveAttrs(h).at(-1)).toBe("<removed>");
  });

  it("should paint the edge exit button with its own copy at mount", () => {
    const h = harnessOf(true);
    boot(h.deps);

    const texts = h.fake.calls
      .filter((call) => call.op === "text" && call.args[0] === `${ROOT} #hr-immersive-exit`)
      .map((call) => call.args[1]);
    expect(texts).toEqual([COPY.immersiveExit]);
  });
});
