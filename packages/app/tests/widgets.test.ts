// 这层管：四个 widget 的**调用序列**契约——AC2.2（outline 没换引用就不重建 TOC）与
// AC2.4（`doc.changed` 只写变化的块，绝不整篇 `html` 重注入）。

import { describe, expect, it } from "vitest";

import { mountCanvas } from "../src/widgets/canvas.ts";
import { mountLibrary } from "../src/widgets/library.ts";
import { mountSidenotes } from "../src/widgets/sidenotes.ts";
import { mountStatusbar } from "../src/widgets/statusbar.ts";
import { createFakeHost, outlineOf, stateOf, targetOf } from "./support/fake-host.ts";

const ROOT = "#hr-root";

describe("library · TOC 只在 outline 换引用时重建", () => {
  it("should build the tree from nested nodes and open a sidenote on click", () => {
    const fake = createFakeHost();
    const intents: unknown[] = [];
    const widget = mountLibrary(fake.host, ROOT, stateOf(), (intent) => {
      intents.push(intent);
    });
    const built = fake.calls.filter((call) => call.op === "children");
    expect(built).toHaveLength(1);
    expect(built[0]?.args[1]).toContain("toc__item--h3");
    fake.fire(`${ROOT} #hr-toc`, "click", {
      closest: () => ({ getAttribute: () => "hr-b" }),
    });
    fake.fire(`${ROOT} #hr-toc`, "click", { closest: () => null });
    expect(intents).toEqual([{ kind: "scrollTo", id: "hr-b" }]);
    expect(widget).toBeDefined();
  });

  it("should not rebuild when the outline reference is unchanged (AC2.2)", () => {
    const outline = outlineOf();
    const fake = createFakeHost();
    const widget = mountLibrary(fake.host, ROOT, stateOf({ outline }), () => undefined);
    widget.update(stateOf({ outline, activeId: "hr-b" }));
    expect(fake.calls.filter((call) => call.op === "children")).toHaveLength(1);
    expect(fake.calls.some((call) => call.op === "cls" && call.args[2] === "1")).toBe(true);
  });

  it("should rebuild exactly once when the outline reference changes", () => {
    const fake = createFakeHost();
    const widget = mountLibrary(fake.host, ROOT, stateOf(), () => undefined);
    widget.update(stateOf({ outline: outlineOf(), activeId: "hr-a" }));
    expect(fake.calls.filter((call) => call.op === "children")).toHaveLength(2);
  });
});

describe("canvas · 正文只注入一次，之后按块 diff（AC2.4）", () => {
  it("should inject the document once and paint theme options", () => {
    const fake = createFakeHost();
    mountCanvas({
      host: fake.host,
      parent: ROOT,
      state: stateOf(),
      input: { html: "<p>一</p>", themes: ["a", "b"] },
      onIntent: () => undefined,
    });
    const htmlCall = fake.calls.find((call) => call.op === "html");
    expect(htmlCall?.args).toEqual([`${ROOT} #hr-doc`, "<p>一</p>"]);
    expect(fake.calls.filter((call) => call.op === "html")).toHaveLength(1);
    expect(fake.calls.some((call) => call.op === "children")).toBe(true);
  });
});

describe("canvas · 块级 diff 只写变化的块", () => {
  it("should write only the changed blocks instead of re-injecting the whole document", () => {
    const fake = createFakeHost(
      () =>
        new Map([
          ["hr-a", "<p>新</p>"],
          ["hr-b", "<p>不变</p>"],
        ]),
    );
    const widget = mountCanvas({
      host: fake.host,
      parent: ROOT,
      state: stateOf({ documentHtml: "old", revision: "r1" }),
      input: { html: "old", themes: [] },
      onIntent: () => undefined,
    });
    // 第二次渲染：revision 变了、块表少了一个（裁定 #8：块被删则 DOM 真删）。
    widget.update(
      stateOf({ documentHtml: "new", revision: "r2", blocks: ["hr-a"], activeId: "hr-a" }),
    );
    expect(fake.ops().filter((op) => op === "html")).toHaveLength(1);
    expect(fake.calls.filter((call) => call.op === "removeBlock")).toEqual([
      { op: "removeBlock", args: ["hr-b"] },
    ]);
    expect(fake.calls.filter((call) => call.op === "blockHtml")).toEqual([
      { op: "blockHtml", args: ["hr-a", "<p>新</p>"] },
    ]);
  });
});

describe("canvas · 正文只注入一次（续）", () => {
  it("should skip the diff when the revision is unchanged", () => {
    const fake = createFakeHost(() => new Map([["hr-a", "<p>新</p>"]]));
    const widget = mountCanvas({
      host: fake.host,
      parent: ROOT,
      state: stateOf({ documentHtml: "old", revision: "r1" }),
      input: { html: "old", themes: [] },
      onIntent: () => undefined,
    });
    widget.update(stateOf({ documentHtml: "new", revision: "r1" }));
    expect(fake.calls.some((call) => call.op === "blocks" || call.op === "blockHtml")).toBe(false);
  });
});

describe("canvas · 焦点与空 HTML（仍不整篇重注入）", () => {
  it("should toggle the focus class without touching the document HTML", () => {
    const fake = createFakeHost();
    const widget = mountCanvas({
      host: fake.host,
      parent: ROOT,
      state: stateOf({ documentHtml: "old" }),
      input: { html: "old", themes: [] },
      onIntent: () => undefined,
    });
    widget.update(stateOf({ documentHtml: "old", focus: true }));
    expect(fake.calls.some((call) => call.op === "cls" && call.args[1] === "canvas--focus")).toBe(
      true,
    );
  });

  it("should skip the diff when the HTML is empty and forward theme picks only when non-empty", () => {
    const fake = createFakeHost();
    const intents: unknown[] = [];
    const widget = mountCanvas({
      host: fake.host,
      parent: ROOT,
      state: stateOf(),
      input: { html: "", themes: [] },
      onIntent: (intent) => {
        intents.push(intent);
      },
    });
    widget.update(stateOf({ documentHtml: "" }));
    fake.fire(`${ROOT} #hr-theme-select`, "change", targetOf("manuscript"));
    fake.fire(`${ROOT} #hr-theme-select`, "change", {});
    fake.fire(`${ROOT} #hr-doc`, "click", { blockId: "hr-b" });
    fake.fire(`${ROOT} #hr-doc`, "click", { blockId: "" });
    fake.fire(`${ROOT} #hr-doc`, "click", {});
    expect(intents).toEqual([
      { kind: "themeSelected", theme: "manuscript" },
      { kind: "scrollTo", id: "hr-b" },
    ]);
  });
});

describe("canvas · syncBlocks", () => {
  it("should forward syncBlocks when the host provides it", () => {
    const fake = createFakeHost(() => new Map([["hr-a", "<p>一</p>"]]));
    const synced: string[] = [];
    const host = {
      ...fake.host,
      syncBlocks: (markup: string) => {
        synced.push(markup);
      },
    };
    const widget = mountCanvas({
      host,
      parent: ROOT,
      state: stateOf({ documentHtml: "old", revision: "r1" }),
      input: { html: "old", themes: [] },
      onIntent: () => undefined,
    });
    widget.update(stateOf({ documentHtml: "new", revision: "r2", blocks: ["hr-a", "hr-b"] }));
    expect(synced).toEqual(["new"]);
  });
});

describe("sidenotes/statusbar · 面板与连接状态", () => {
  it("should report the panel state and the active sidenote id", () => {
    const fake = createFakeHost();
    const widget = mountSidenotes(fake.host, ROOT);
    widget.update(stateOf({ panel: "sidenote", sidenoteId: "hr-a" }));
    widget.update(stateOf({ panel: "closed", sidenoteId: undefined }));
    expect(fake.calls.filter((call) => call.op === "attr")).toEqual([
      { op: "attr", args: [`${ROOT} #hr-notes`, "data-active-id", "hr-a"] },
      { op: "attr", args: [`${ROOT} #hr-notes`, "data-active-id", "<removed>"] },
    ]);
    // `sidenotes--open` 不归 widget 管：它的唯一写者是 `syncView`（`wiring.ts:84`），
    // 因为“打开”由 `panel === "sidenote" || diff.open` 两个字段共同决定。
    // 那条表达式的断言在 `wiring.test.ts`（`syncView · 面板开合类`）。
  });

  it("should rewrite the connection text only when it changes", () => {
    const fake = createFakeHost();
    const widget = mountStatusbar(fake.host, ROOT);
    widget.update(stateOf({ conn: "live" }));
    widget.update(stateOf({ conn: "live" }));
    widget.update(stateOf({ conn: "offline" }));
    const texts = fake.calls.filter(
      (call) => call.op === "text" && call.args[0] === `${ROOT} #hr-conn`,
    );
    expect(texts.map((call) => call.args[1])).toEqual(["已同步", "离线"]);
    expect(
      fake.calls.filter((call) => call.op === "attr" && call.args[1] === "data-doc"),
    ).toHaveLength(3);
  });
});
