// 这层管：`widgets/search.ts`（D61 搜索面板）——开合、防抖、过期响应、分组、
// 键盘导航、Enter 打开、combine:"or" 提示与空/错/超长三态。
// 计时器走注入的 `Schedule`（手动钟），断言只看 fake host 的调用序列。

import { describe, expect, it } from "vitest";

import type { HostCall } from "./support/fake-host.ts";
import { createFakeHost, stateOf, type FakeHost } from "./support/fake-host.ts";
import type { Schedule } from "../src/flash.ts";
import type { SearchHit, SearchReply } from "../src/guard.ts";
import type { ReaderIntent } from "../src/state.ts";
import { COPY } from "../src/widgets/copy.ts";
import { mountSearch } from "../src/widgets/search.ts";

const ROOT = "#hr-root";
const PANEL = `${ROOT} #hr-search-panel`;
const INPUT = `${ROOT} #hr-search-input`;
const HINT = `${ROOT} #hr-search-hint`;
const DOCS = `${ROOT} #hr-search-docs`;
const DOCS_LIST = `${ROOT} #hr-search-docs-list`;
const DOCS_TITLE = `${ROOT} #hr-search-docs-title`;
const ANNS = `${ROOT} #hr-search-anns`;
const ANNS_LIST = `${ROOT} #hr-search-anns-list`;
const ANNS_TITLE = `${ROOT} #hr-search-anns-title`;

interface Pending {
  readonly query: string;
  readonly resolve: (reply: SearchReply) => void;
  readonly reject: (cause: unknown) => void;
}

interface Rig {
  readonly fake: FakeHost;
  readonly widget: ReturnType<typeof mountSearch>;
  readonly timers: { run: () => void; ms: number; cancelled: boolean }[];
  readonly intents: ReaderIntent[];
  readonly opened: SearchHit[];
  readonly fetches: Pending[];
}

const mount = (options: { focusless?: boolean } = {}): Rig => {
  const fake = createFakeHost();
  const timers: Rig["timers"] = [];
  const intents: ReaderIntent[] = [];
  const opened: SearchHit[] = [];
  const fetches: Pending[] = [];
  const schedule: Schedule = (ms, run) => {
    const timer = { run, ms, cancelled: false };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  const { focus: stripped, ...focusless } = fake.host;
  expect(stripped).toBeTypeOf("function");
  const widget = mountSearch({
    host: options.focusless ? focusless : fake.host,
    parent: ROOT,
    fetch: (query) =>
      new Promise<SearchReply>((resolve, reject) => {
        fetches.push({ query, resolve, reject });
      }),
    openHit: (hit) => {
      opened.push(hit);
    },
    onIntent: (intent) => {
      intents.push(intent);
    },
    schedule,
  });
  return { fake, widget, timers, intents, opened, fetches };
};

const hitOf = (over: Partial<SearchHit> = {}): SearchHit => ({
  path: "doc.html",
  title: "标题",
  kind: "doc",
  score: 1,
  snippet: "一段正文",
  highlights: [],
  ...over,
});

const replyOf = (results: readonly SearchHit[], combine: "and" | "or" = "and"): SearchReply => ({
  results,
  total: results.length,
  combine,
  truncated: false,
  diagnostics: [],
});

const callsOn = (fake: FakeHost, op: string, selector: string): readonly HostCall[] =>
  fake.calls.filter((call) => call.op === op && call.args[0] === selector);

const lastText = (fake: FakeHost, selector: string): string | undefined =>
  callsOn(fake, "text", selector)
    .map((call) => call.args[1])
    .at(-1);

const attrsOf = (fake: FakeHost, selector: string, name: string): readonly string[] =>
  callsOn(fake, "attr", selector)
    .filter((call) => call.args[1] === name)
    .map((call) => call.args[2] ?? "");

const childrenSpecs = (fake: FakeHost, selector: string): readonly unknown[] =>
  callsOn(fake, "children", selector).map((call) => JSON.parse(call.args[1] ?? "[]") as unknown[]);

const openPanel = (rig: Rig): void => {
  rig.widget.update(stateOf({ searchOpen: true }));
};

const type = (rig: Rig, value: string): void => {
  rig.fake.fire(INPUT, "input", { value });
};

const query = (rig: Rig, value: string): void => {
  type(rig, value);
  rig.timers.at(-1)?.run();
};

describe("search widget · 开合", () => {
  it("should write mount-time markers: capability attr, placeholder, group titles", () => {
    const rig = mount();
    expect(attrsOf(rig.fake, ROOT, "data-hr-search")).toEqual([""]);
    expect(attrsOf(rig.fake, INPUT, "placeholder")).toEqual([COPY.searchPlaceholder]);
    expect(attrsOf(rig.fake, INPUT, "aria-label")).toEqual([COPY.searchTitle]);
    expect(lastText(rig.fake, DOCS_TITLE)).toBe(COPY.searchDocs);
    expect(lastText(rig.fake, ANNS_TITLE)).toBe(COPY.searchAnns);
  });

  it("should unhide, clear, focus and show the idle hint on open; hide on close", () => {
    const rig = mount();
    openPanel(rig);

    expect(attrsOf(rig.fake, PANEL, "hidden")).toEqual(["<removed>"]);
    expect(callsOn(rig.fake, "focus", INPUT)).toHaveLength(1);
    expect(lastText(rig.fake, HINT)).toBe(COPY.searchIdle);
    expect(lastText(rig.fake, `${ROOT} #hr-hint`)).toBe(COPY.searchIdle);
    expect(lastText(rig.fake, INPUT)).toBe("");

    rig.widget.update(stateOf({ searchOpen: false }));
    expect(attrsOf(rig.fake, PANEL, "hidden").at(-1)).toBe("");
    expect(lastText(rig.fake, HINT)).toBe("");
  });

  it("should not repaint when update carries an unchanged searchOpen", () => {
    const rig = mount();
    openPanel(rig);
    const before = rig.fake.calls.length;
    rig.widget.update(stateOf({ searchOpen: true }));
    rig.widget.update(stateOf({ searchOpen: true }));
    expect(rig.fake.calls.length).toBe(before);
  });

  it("should dispatch searchOpened when the desktop event lands on the root", () => {
    const rig = mount();
    rig.fake.fire(ROOT, "hr-search-open", {});
    expect(rig.intents).toEqual([{ kind: "searchOpened" }]);
  });
});

describe("search widget · 防抖与过期响应", () => {
  it("should issue one request per pause (150ms debounce via injected timers)", () => {
    const rig = mount();
    openPanel(rig);

    type(rig, "摩");
    type(rig, "摩托");
    type(rig, "摩托车");
    expect(rig.fetches).toHaveLength(0);
    expect(rig.timers).toHaveLength(3);
    expect(rig.timers[0]?.cancelled).toBe(true);
    expect(rig.timers[1]?.cancelled).toBe(true);
    expect(rig.timers[2]?.ms).toBe(150);

    rig.timers[2]?.run();
    expect(rig.fetches).toHaveLength(1);
    expect(rig.fetches[0]?.query).toBe("摩托车");
  });

  it("should ignore stale responses (an older query never overwrites a newer one)", async () => {
    const rig = mount();
    openPanel(rig);

    query(rig, "旧词");
    query(rig, "新词");
    expect(rig.fetches.map((fetch) => fetch.query)).toEqual(["旧词", "新词"]);

    // 新响应先到：渲染它；旧响应后到：seq 对不上直接丢。
    rig.fetches[1]?.resolve(replyOf([hitOf({ title: "新结果" })]));
    await Promise.resolve();
    rig.fetches[0]?.resolve(replyOf([hitOf({ title: "旧结果" })]));
    await Promise.resolve();

    // clearLists 留下的那次空写在前，最后一笔才是新结果；旧结果一笔都没写。
    const specs = childrenSpecs(rig.fake, DOCS_LIST);
    const last = specs.at(-1) as readonly unknown[];
    expect(last).toHaveLength(1);
    expect(JSON.stringify(last)).toContain("新结果");
    for (const call of specs) expect(JSON.stringify(call)).not.toContain("旧结果");
  });

  it("should drop a response that lands after the panel closed", async () => {
    const rig = mount();
    openPanel(rig);
    query(rig, "词");
    rig.widget.update(stateOf({ searchOpen: false }));

    rig.fetches[0]?.resolve(replyOf([hitOf()]));
    await Promise.resolve();

    // 列表上只留下 show/hide 两次清空，迟到的响应一笔结果都没写。
    for (const specs of childrenSpecs(rig.fake, DOCS_LIST)) {
      expect(specs).toEqual([]);
    }
    expect(lastText(rig.fake, HINT)).toBe("");
  });

  it("should drop a rejection that lands after a newer query started", async () => {
    const rig = mount();
    openPanel(rig);
    query(rig, "一");
    query(rig, "二");

    rig.fetches[0]?.reject(new Error("旧失败"));
    await Promise.resolve();
    // 旧 reject 不碰提示行：提示仍是新查询的"搜索中"。
    expect(lastText(rig.fake, HINT)).toBe(COPY.searchLoading);

    rig.fetches[1]?.reject("非 Error 失败");
    await Promise.resolve();
    expect(lastText(rig.fake, HINT)).toBe(`${COPY.searchError}非 Error 失败`);
  });
});

describe("search widget · 分组与导航", () => {
  it("should group doc and annotation hits with a shared flat index", async () => {
    const rig = mount();
    openPanel(rig);
    query(rig, "词");
    rig.fetches[0]?.resolve(
      replyOf([
        hitOf({ path: "a.html", title: "甲" }),
        hitOf({ path: "b.html", kind: "annotation", annotationId: "an-1", title: "" }),
        hitOf({ path: "c.html", title: "丙" }),
      ]),
    );
    await Promise.resolve();

    const docs = childrenSpecs(rig.fake, DOCS_LIST).at(-1) as {
      attrs?: { "data-hr-index"?: string };
    }[];
    const anns = childrenSpecs(rig.fake, ANNS_LIST).at(-1) as {
      attrs?: { "data-hr-index"?: string };
    }[];
    // 文档组 2 条（index 0、1），批注组 1 条（index 2）——扁平序号跨组连续。
    expect(docs.map((item) => item.attrs?.["data-hr-index"])).toEqual(["0", "1"]);
    expect(anns.map((item) => item.attrs?.["data-hr-index"])).toEqual(["2"]);
    expect(attrsOf(rig.fake, DOCS, "hidden").at(-1)).toBe("<removed>");
    expect(attrsOf(rig.fake, ANNS, "hidden").at(-1)).toBe("<removed>");
    // 空标题回退成 path（仍是纯文本）。
    expect(JSON.stringify(anns)).toContain("b.html");
  });

  it("should hide the empty group when only one kind matched", async () => {
    const rig = mount();
    openPanel(rig);
    query(rig, "词");
    rig.fetches[0]?.resolve(replyOf([hitOf({ kind: "annotation", annotationId: "a1" })]));
    await Promise.resolve();

    expect(attrsOf(rig.fake, DOCS, "hidden").at(-1)).toBe("");
    expect(attrsOf(rig.fake, ANNS, "hidden").at(-1)).toBe("<removed>");
  });

  it("should move the active item with arrows and open it with Enter", async () => {
    const rig = mount();
    openPanel(rig);
    query(rig, "词");
    rig.fetches[0]?.resolve(replyOf([hitOf({ path: "a.html" }), hitOf({ path: "b.html" })]));
    await Promise.resolve();

    const clsCalls = () =>
      rig.fake.calls.filter((call) => call.op === "cls" && call.args[1] === "search__item--on");
    expect(clsCalls()).toHaveLength(0);

    rig.fake.fire(INPUT, "keydown", { key: "ArrowDown" });
    rig.fake.fire(INPUT, "keydown", { key: "ArrowDown" });
    // 第三条按下回绕到底部 index 1（0→1→0→1）。
    rig.fake.fire(INPUT, "keydown", { key: "ArrowDown" });
    expect(clsCalls().at(-1)?.args).toEqual([
      `${PANEL} [data-hr-index="1"]`,
      "search__item--on",
      "1",
    ]);

    rig.fake.fire(INPUT, "keydown", { key: "Enter" });
    expect(rig.intents).toEqual([{ kind: "panelClosed" }]);
    expect(rig.opened).toEqual([hitOf({ path: "b.html" })]);
  });

  it("should move the active item up with ArrowUp and wrap around", async () => {
    const rig = mount();
    openPanel(rig);
    query(rig, "词");
    rig.fetches[0]?.resolve(replyOf([hitOf({ path: "a.html" }), hitOf({ path: "b.html" })]));
    await Promise.resolve();

    // 0 起按 ArrowUp：模回绕到末位（index 1）；再一次回到 0。
    rig.fake.fire(INPUT, "keydown", { key: "ArrowUp" });
    let clsCalls = rig.fake.calls.filter(
      (call) => call.op === "cls" && call.args[1] === "search__item--on" && call.args[2] === "1",
    );
    expect(clsCalls.at(-1)?.args[0]).toBe(`${PANEL} [data-hr-index="1"]`);

    rig.fake.fire(INPUT, "keydown", { key: "ArrowUp" });
    clsCalls = rig.fake.calls.filter(
      (call) => call.op === "cls" && call.args[1] === "search__item--on" && call.args[2] === "1",
    );
    expect(clsCalls.at(-1)?.args[0]).toBe(`${PANEL} [data-hr-index="0"]`);
  });

  it("should open a click target and close the panel first", async () => {
    const rig = mount();
    openPanel(rig);
    query(rig, "词");
    rig.fetches[0]?.resolve(replyOf([hitOf(), hitOf({ path: "b.html" })]));
    await Promise.resolve();

    rig.fake.fire(PANEL, "click", {
      closest: () => ({ getAttribute: () => "1" }),
    });
    expect(rig.intents).toEqual([{ kind: "panelClosed" }]);
    expect(rig.opened[0]?.path).toBe("b.html");
  });

  it("should no-op on Escape (intent), Enter with no hits, clicks off items and unknown keys", () => {
    const rig = mount();
    openPanel(rig);

    rig.fake.fire(INPUT, "keydown", { key: "Enter" });
    rig.fake.fire(INPUT, "keydown", { key: "ArrowDown" });
    rig.fake.fire(INPUT, "keydown", { key: "x" });
    rig.fake.fire(PANEL, "click", { closest: () => null });
    rig.fake.fire(PANEL, "click", {
      closest: () => ({ getAttribute: () => "9" }),
    });
    expect(rig.opened).toEqual([]);
    // 以上键鼠动作都不产生意图 —— Escape 是键位出口，不是"任意键"。
    expect(rig.intents).toEqual([]);

    rig.fake.fire(INPUT, "keydown", { key: "Escape" });
    expect(rig.intents).toEqual([{ kind: "panelClosed" }]);
  });
});

describe("search widget · 防抖计时器的开合清理", () => {
  it("should cancel a queued debounce when the panel closes", () => {
    const rig = mount();
    openPanel(rig);
    type(rig, "词");
    expect(rig.timers).toHaveLength(1);

    rig.widget.update(stateOf({ searchOpen: false }));

    expect(rig.timers[0]?.cancelled).toBe(true);
    expect(rig.fetches).toHaveLength(0);
  });

  it("should cancel a debounce queued while closed when the panel opens", () => {
    const rig = mount();
    // 事件注册与面板开否无关：假 host 可直接派发，真 DOM 里隐藏输入框摸不到——
    // show() 必须收掉这条路径排下的计时器，否则开面板瞬间发起一次过期查询。
    type(rig, "词");
    expect(rig.timers).toHaveLength(1);

    openPanel(rig);

    expect(rig.timers[0]?.cancelled).toBe(true);
    expect(rig.fetches).toHaveLength(0);
    expect(lastText(rig.fake, HINT)).toBe(COPY.searchIdle);
  });
});

describe("search widget · 高亮 run 的钳制与排序", () => {
  const snippetRuns = async (
    rig: Rig,
    highlights: readonly (readonly [number, number])[],
  ): Promise<readonly { tag?: string; text?: string }[]> => {
    openPanel(rig);
    query(rig, "词");
    rig.fetches[0]?.resolve(replyOf([hitOf({ snippet: "0123456789", highlights })], "and"));
    await Promise.resolve();
    const specs = childrenSpecs(rig.fake, DOCS_LIST).at(-1) as {
      children?: { children?: { tag?: string; text?: string }[] }[];
    }[];
    return specs[0]?.children?.[1]?.children ?? [];
  };

  it("should sort same-start pairs by end before cutting runs", async () => {
    const rig = mount();
    const runs = await snippetRuns(rig, [
      [1, 5],
      [1, 2],
    ]);
    expect(runs).toEqual([
      { tag: "span", text: "0" },
      { tag: "mark", text: "1" },
      { tag: "mark", text: "234" },
      { tag: "span", text: "56789" },
    ]);
  });

  it("should drop a pair fully inside an earlier one", async () => {
    const rig = mount();
    const runs = await snippetRuns(rig, [
      [0, 5],
      [2, 3],
    ]);
    expect(runs).toEqual([
      { tag: "mark", text: "01234" },
      { tag: "span", text: "56789" },
    ]);
  });
});

describe("search widget · 状态文案", () => {
  it("should show the partial-match hint only when combine is or", async () => {
    const rig = mount();
    openPanel(rig);
    query(rig, "词");
    rig.fetches[0]?.resolve(replyOf([hitOf()], "or"));
    await Promise.resolve();
    expect(lastText(rig.fake, HINT)).toBe(COPY.searchPartial);

    query(rig, "词二");
    rig.fetches[1]?.resolve(replyOf([hitOf()], "and"));
    await Promise.resolve();
    expect(lastText(rig.fake, HINT)).toBe("");
  });

  it("should show the empty state on zero results and clear it on the next query", async () => {
    const rig = mount();
    openPanel(rig);
    query(rig, "没有");
    rig.fetches[0]?.resolve(replyOf([]));
    await Promise.resolve();
    expect(lastText(rig.fake, HINT)).toBe(COPY.searchEmpty);

    // 正常输入不清提示（防闪烁）：停笔防抖一到才转"搜索中"。
    type(rig, "下");
    expect(lastText(rig.fake, HINT)).toBe(COPY.searchEmpty);
    rig.timers.at(-1)?.run();
    expect(lastText(rig.fake, HINT)).toBe(COPY.searchLoading);
  });

  it("should show the error message (never sent over 200 code points) and refuse blank input", async () => {
    const rig = mount();
    openPanel(rig);

    type(rig, "   ");
    expect(rig.fetches).toHaveLength(0);
    expect(lastText(rig.fake, HINT)).toBe(COPY.searchIdle);

    // 不带 value 的 input 事件（非输入框元素触达这条 handler）：与空白同路，回到 idle 提示。
    rig.fake.fire(INPUT, "input", {});
    expect(rig.fetches).toHaveLength(0);
    expect(lastText(rig.fake, HINT)).toBe(COPY.searchIdle);

    type(rig, "好".repeat(201));
    expect(rig.fetches).toHaveLength(0);
    expect(lastText(rig.fake, HINT)).toBe(COPY.searchTooLong);

    query(rig, "崩");
    rig.fetches[0]?.reject(new Error("500"));
    await Promise.resolve();
    expect(lastText(rig.fake, HINT)).toBe(`${COPY.searchError}500`);
    expect(childrenSpecs(rig.fake, DOCS_LIST).at(-1)).toEqual([]);
  });

  it("should keep 200 code points sendable (the bound is exclusive, not inclusive)", () => {
    const rig = mount();
    openPanel(rig);
    type(rig, "界".repeat(200));
    rig.timers.at(-1)?.run();
    expect(rig.fetches).toHaveLength(1);
  });
});

interface LiSpec {
  readonly attrs?: Record<string, string>;
  readonly children?: readonly LiSpec[];
  readonly tag?: string;
  readonly text?: string;
}

const lastItems = (rig: Rig, list: string): readonly LiSpec[] =>
  childrenSpecs(rig.fake, list).at(-1) as readonly LiSpec[];

describe("search widget · 列表项的内部结构", () => {
  it("should render kind badge / title / snippet classes and keep a flat cross-group index", async () => {
    const rig = mount();
    openPanel(rig);
    query(rig, "词");
    rig.fetches[0]?.resolve(
      replyOf([
        hitOf({ title: "文档题" }),
        hitOf({ kind: "annotation", annotationId: "a1", title: "批注题" }),
        hitOf({ kind: "annotation", annotationId: "a2", title: "批注二" }),
      ]),
    );
    await Promise.resolve();

    const docs = lastItems(rig, DOCS_LIST);
    const anns = lastItems(rig, ANNS_LIST);
    // 扁平序号必须跨组连续：docs.length + index，错一位（减/不加）这里就偏。
    expect(anns.map((item) => item.attrs?.["data-hr-index"])).toEqual(["1", "2"]);

    const doc = docs[0];
    // 渲染即带活跃项（首条），active 类名挂在第一项、不挂第二项。
    expect(doc?.attrs?.["class"]).toBe("search__item search__item--on");
    expect(doc?.attrs?.["role"]).toBe("option");
    expect(anns[0]?.attrs?.["class"]).toBe("search__item");

    const titleP = doc?.children?.[0];
    const kindSpan = titleP?.children?.[0];
    expect(titleP?.attrs?.["class"]).toBe("search__title");
    expect(titleP?.tag).toBe("p");
    expect(kindSpan?.attrs?.["class"]).toBe("search__kind");
    expect(kindSpan?.tag).toBe("span");
    // kind 徽标文案按 hit.kind 分流：文档题标"文档"，批注题标"批注"。
    expect(kindSpan?.text).toBe(COPY.searchDocs);
    expect(anns[0]?.children?.[0]?.children?.[0]?.text).toBe(COPY.searchAnns);
    expect(titleP?.children?.[1]?.text).toBe("文档题");

    const snippetP = doc?.children?.[1];
    expect(snippetP?.tag).toBe("p");
    expect(snippetP?.attrs?.["class"]).toBe("search__snippet");
  });

  it("should hide the annotations group when a reply carries only docs", async () => {
    const rig = mount();
    openPanel(rig);
    query(rig, "词");
    rig.fetches[0]?.resolve(replyOf([hitOf()]));
    await Promise.resolve();

    expect(attrsOf(rig.fake, ANNS, "hidden").at(-1)).toBe("");
    expect(attrsOf(rig.fake, DOCS, "hidden").at(-1)).toBe("<removed>");
  });
});

describe("search widget · snippet 的空/反向/贴边高亮", () => {
  const runsOf = async (
    rig: Rig,
    snippet: string,
    highlights: readonly (readonly [number, number])[],
  ): Promise<readonly { tag?: string; text?: string }[]> => {
    openPanel(rig);
    query(rig, "词");
    rig.fetches[0]?.resolve(replyOf([hitOf({ snippet, highlights })]));
    await Promise.resolve();
    return lastItems(rig, DOCS_LIST)[0]?.children?.[1]?.children ?? [];
  };

  it("should render exactly one empty span for an empty snippet", async () => {
    const rig = mount();
    const runs = await runsOf(rig, "", []);
    expect(runs).toEqual([{ tag: "span", text: "" }]);
  });

  it("should drop reversed and zero-length pairs before cutting runs", async () => {
    const rig = mount();
    const runs = await runsOf(rig, "0123456789", [
      [0, 2],
      [5, 5],
      [7, 5],
    ]);
    expect(runs).toEqual([
      { tag: "mark", text: "01" },
      { tag: "span", text: "23456789" },
    ]);
  });

  it("should skip a pair whose end lands exactly on the covered position", async () => {
    const rig = mount();
    const runs = await runsOf(rig, "0123456789", [
      [0, 4],
      [1, 4],
    ]);
    expect(runs).toEqual([
      { tag: "mark", text: "0123" },
      { tag: "span", text: "456789" },
    ]);
  });

  it("should not append a trailing empty span when a mark reaches the snippet end", async () => {
    const rig = mount();
    const runs = await runsOf(rig, "0123456789", [[0, 10]]);
    expect(runs).toEqual([{ tag: "mark", text: "0123456789" }]);
  });
});

describe("search widget · 键盘位移的每一步都可观测", () => {
  it("should not write cls/scrollTo when there is nothing to move", () => {
    const rig = mount();
    openPanel(rig);
    rig.fake.fire(INPUT, "keydown", { key: "ArrowDown" });
    rig.fake.fire(INPUT, "keydown", { key: "ArrowUp" });
    expect(rig.fake.calls.filter((call) => call.op === "cls")).toHaveLength(0);
    expect(rig.fake.calls.filter((call) => call.op === "scrollTo")).toHaveLength(0);
  });

  it("should repaint the old item off, the new item on, and scroll to it", async () => {
    const rig = mount();
    openPanel(rig);
    query(rig, "词");
    rig.fetches[0]?.resolve(replyOf([hitOf({ path: "a.html" }), hitOf({ path: "b.html" })]));
    await Promise.resolve();

    rig.fake.fire(INPUT, "keydown", { key: "ArrowDown" });
    const cls = rig.fake.calls.filter((call) => call.op === "cls");
    expect(cls.map((call) => call.args)).toEqual([
      [`${PANEL} [data-hr-index="0"]`, "search__item--on", "0"],
      [`${PANEL} [data-hr-index="1"]`, "search__item--on", "1"],
    ]);
    expect(callsOn(rig.fake, "scrollTo", `${PANEL} [data-hr-index="1"]`)).toHaveLength(1);
  });

  it("should move up one step with ArrowUp from the middle of three hits", async () => {
    const rig = mount();
    openPanel(rig);
    query(rig, "词");
    rig.fetches[0]?.resolve(
      replyOf([hitOf({ path: "a.html" }), hitOf({ path: "b.html" }), hitOf({ path: "c.html" })]),
    );
    await Promise.resolve();

    rig.fake.fire(INPUT, "keydown", { key: "ArrowDown" });
    rig.fake.fire(INPUT, "keydown", { key: "ArrowUp" });
    // 从 index 1 向上只能到 0：+1 方向会落在 2。
    const onCalls = rig.fake.calls.filter((call) => call.op === "cls" && call.args[2] === "1");
    expect(onCalls.at(-1)?.args[0]).toBe(`${PANEL} [data-hr-index="0"]`);
  });
});

describe("search widget · 点击目标的属性解析", () => {
  it("should resolve the index through the [data-hr-index] selector and attribute name", async () => {
    const rig = mount();
    openPanel(rig);
    query(rig, "词");
    rig.fetches[0]?.resolve(replyOf([hitOf(), hitOf({ path: "b.html" })]));
    await Promise.resolve();

    // 假 closest 只认自己的选择器、假 getAttribute 只认自己的名字——换错任一参数即落空。
    rig.fake.fire(PANEL, "click", {
      closest: (selector: string) =>
        selector === "[data-hr-index]"
          ? {
              getAttribute: (name: string) => (name === "data-hr-index" ? "1" : null),
            }
          : null,
    });
    expect(rig.opened[0]?.path).toBe("b.html");
  });

  it("should no-op (not throw) on a click target without closest", () => {
    const rig = mount();
    openPanel(rig);
    rig.fake.fire(PANEL, "click", {});
    expect(rig.opened).toEqual([]);
    expect(rig.intents).toEqual([]);
  });
});

describe("search widget · 开合/过期时列表与计时器的清理", () => {
  it("should empty both lists and re-hide both groups on hide", async () => {
    const rig = mount();
    openPanel(rig);
    query(rig, "词");
    rig.fetches[0]?.resolve(replyOf([hitOf(), hitOf({ kind: "annotation", annotationId: "a" })]));
    await Promise.resolve();

    rig.widget.update(stateOf({ searchOpen: false }));
    expect(childrenSpecs(rig.fake, DOCS_LIST).at(-1)).toEqual([]);
    expect(childrenSpecs(rig.fake, ANNS_LIST).at(-1)).toEqual([]);
    expect(attrsOf(rig.fake, DOCS, "hidden").at(-1)).toBe("");
    expect(attrsOf(rig.fake, ANNS, "hidden").at(-1)).toBe("");
  });

  it("should write the cleared (empty) lists on first open", () => {
    const rig = mount();
    openPanel(rig);
    expect(childrenSpecs(rig.fake, DOCS_LIST).at(-1)).toEqual([]);
    expect(childrenSpecs(rig.fake, ANNS_LIST).at(-1)).toEqual([]);
    expect(attrsOf(rig.fake, DOCS, "hidden").at(-1)).toBe("");
    expect(attrsOf(rig.fake, ANNS, "hidden").at(-1)).toBe("");
  });

  it("should drop a response that resolves across a close+reopen (seq must move forward)", async () => {
    const rig = mount();
    openPanel(rig);
    query(rig, "旧词");
    rig.widget.update(stateOf({ searchOpen: false }));
    rig.widget.update(stateOf({ searchOpen: true }));

    rig.fetches[0]?.resolve(replyOf([hitOf({ title: "迟到" })]));
    await Promise.resolve();

    // 重开后只有一次清空写：迟到响应若混进来，最后一笔会是它的列表。
    expect(childrenSpecs(rig.fake, DOCS_LIST).at(-1)).toEqual([]);
    expect(lastText(rig.fake, HINT)).toBe(COPY.searchIdle);
  });

  it("should clear rendered lists when the next query fails", async () => {
    const rig = mount();
    openPanel(rig);
    query(rig, "词");
    rig.fetches[0]?.resolve(replyOf([hitOf({ title: "旧结果" })]));
    await Promise.resolve();

    query(rig, "崩");
    rig.fetches[1]?.reject(new Error("500"));
    await Promise.resolve();
    expect(childrenSpecs(rig.fake, DOCS_LIST).at(-1)).toEqual([]);
    expect(childrenSpecs(rig.fake, ANNS_LIST).at(-1)).toEqual([]);
  });

  it("should clear rendered lists on empty input and on overlong input", async () => {
    const rig = mount();
    openPanel(rig);
    query(rig, "词");
    rig.fetches[0]?.resolve(replyOf([hitOf()]));
    await Promise.resolve();

    type(rig, "");
    expect(childrenSpecs(rig.fake, DOCS_LIST).at(-1)).toEqual([]);
    expect(lastText(rig.fake, HINT)).toBe(COPY.searchIdle);

    query(rig, "词");
    rig.fetches[1]?.resolve(replyOf([hitOf()]));
    await Promise.resolve();

    type(rig, "好".repeat(201));
    expect(childrenSpecs(rig.fake, DOCS_LIST).at(-1)).toEqual([]);
    expect(lastText(rig.fake, HINT)).toBe(COPY.searchTooLong);
  });

  it("should schedule nothing for whitespace or value-less input", () => {
    const rig = mount();
    openPanel(rig);

    type(rig, "   ");
    rig.timers.at(-1)?.run();
    rig.fake.fire(INPUT, "input", {});
    rig.timers.at(-1)?.run();
    expect(rig.fetches).toHaveLength(0);
    expect(lastText(rig.fake, HINT)).toBe(COPY.searchIdle);
  });

  it("should open fine on a host without focus", () => {
    const rig = mount({ focusless: true });
    expect(() => {
      openPanel(rig);
    }).not.toThrow();
    expect(attrsOf(rig.fake, PANEL, "hidden")).toEqual(["<removed>"]);
  });
});
