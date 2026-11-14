// 这层管：`createDomHost`——把 `Host` 的每个方法映射到 `document` 的具体成员，
// 以及"只在真的变了才写"（text/html/blockHtml 的相等短路）。

import { describe, expect, it } from "vitest";

import { createDomHost, type NodeSpec } from "../src/dom.ts";
import {
  createFakeDocument,
  fakeElement,
  withBlocks,
  type FakeDocument,
  type FakeElement,
} from "./support/fake-dom.ts";

const docWith = (pairs: readonly (readonly [string, FakeElement])[]): FakeDocument => {
  const doc = createFakeDocument();
  for (const [selector, element] of pairs) doc.bySelector.set(selector, element);
  return doc;
};

describe("text/attr/html · 只在变化时写", () => {
  it("should write text once and skip the identical value", () => {
    const element = fakeElement("span");
    const host = createDomHost(docWith([["#t", element]]));
    host.text("#t", "a");
    host.text("#t", "a");
    host.text("#missing", "b");
    expect(element.textContent).toBe("a");
  });

  it("should set and remove attributes, and ignore missing elements", () => {
    const element = fakeElement("div");
    const host = createDomHost(docWith([["#a", element]]));
    host.attr("#a", "data-x", "1");
    host.attr("#a", "data-x", undefined);
    host.attr("#missing", "data-x", "2");
    expect(element.getAttribute("data-x")).toBeNull();
  });

  it("should skip identical innerHTML but write a different one", () => {
    const element = fakeElement("div");
    const host = createDomHost(docWith([["#h", element]]));
    element.innerHTML = "<b>x</b>";
    element.htmlWrites.length = 0;
    host.html("#h", "<b>x</b>");
    host.html("#h", "<i>y</i>");
    host.html("#missing", "<i>z</i>");
    expect(element.innerHTML).toBe("<i>y</i>");
    expect(element.htmlWrites).toEqual(["<i>y</i>"]);
  });
});

describe("cls/focus/scrollTo · 可选元素不炸", () => {
  it("should toggle classes and tolerate a missing selector", () => {
    const element = fakeElement("div");
    const host = createDomHost(docWith([["#c", element]]));
    host.cls("#c", "on", true);
    host.cls("#missing", "on", true);
    expect(element.classes.get("on")).toBe(true);
  });

  it("should call focus and scrollIntoView when the element has them", () => {
    const seen = fakeElement("div");
    const bare = fakeElement("div", false);
    const host = createDomHost(
      docWith([
        ["#f", seen],
        ["#b", bare],
      ]),
    );
    host.focus("#f");
    host.scrollTo("#f");
    host.focus("#b");
    host.scrollTo("#b");
    host.focus("#missing");
    expect(seen.calls).toEqual(["focus", "scroll:start"]);
    expect(bare.calls).toEqual([]);
  });
});

const SPECS: readonly NodeSpec[] = [
  { tag: "li", attrs: { class: "x" }, text: "一", children: [{ tag: "b", text: "二" }] },
  { tag: "li" },
];

describe("children/blocks/blockHtml · 正文增量", () => {
  it("should paint NodeSpec children into the container", () => {
    const container = fakeElement("ul");
    const doc = docWith([["#c", container]]);
    const host = createDomHost(doc);
    const specs = SPECS;
    host.children("#c", specs);
    host.children("#missing", specs);
    expect(container.children).toHaveLength(2);
    expect(container.children[0]?.getAttribute("class")).toBe("x");
    expect(doc.created.filter((element) => element.tag === "li")).toHaveLength(2);
    expect(doc.created.filter((element) => element.tag === "b")).toHaveLength(1);
  });

  it("should index blocks by data-hr-id and skip id-less nodes", () => {
    const doc = createFakeDocument();
    const host = createDomHost(doc);
    const named = fakeElement("p");
    named.setAttribute("data-hr-id", "hr-a");
    named.innerHTML = "<em>a</em>";
    const anonymous = fakeElement("p");
    const box = doc.createElement("div");
    withBlocks(box, [named, anonymous]);
    doc.createElement = () => box;
    const index = host.blocks("<p data-hr-id=hr-a>x</p>");
    expect([...index.entries()]).toEqual([["hr-a", "<em>a</em>"]]);
  });

  it("should replace only a changed block and ignore a missing one", () => {
    const block = fakeElement("p");
    const host = createDomHost(docWith([['[data-hr-id="hr-a"]', block]]));
    host.blockHtml("hr-a", "<em>new</em>");
    host.blockHtml("hr-a", "<em>new</em>");
    host.blockHtml("hr-z", "<em>other</em>");
    expect(block.innerHTML).toBe("<em>new</em>");
    expect(block.htmlWrites).toEqual(["<em>new</em>"]);
  });
});

const noop = (): void => undefined;

describe("on/destroy · 监听与解绑", () => {
  it("should register, fire and unbind a handler", () => {
    const element = fakeElement("div");
    const host = createDomHost(docWith([["#o", element]]));
    const seen: string[] = [];
    const off = host.on("#o", "click", (target) => {
      seen.push(target.value ?? "");
    });
    element.fire("click", { value: "v" });
    off();
    element.fire("click", { value: "ignored" });
    expect(seen).toEqual(["v"]);
    expect(element.listeners).toEqual([]);
  });
});

describe("on/destroy · tocId 预解析", () => {
  it("should pre-resolve tocId and fall back to undefined without a data-toc-id ancestor", () => {
    const element = fakeElement("div");
    const host = createDomHost(docWith([["#o", element]]));
    const seen: (string | undefined)[] = [];
    host.on("#o", "click", (target) => {
      seen.push(target.tocId);
    });
    element.fire("click", { closest: () => ({ getAttribute: () => "hr-a" }) });
    element.fire("click", { closest: () => null });
    expect(seen).toEqual(["hr-a", undefined]);
  });

  it("should return a no-op unbinder for a missing selector", () => {
    const host = createDomHost(createFakeDocument());
    const off = host.on("#missing", "click", noop);
    expect(off).toBeTypeOf("function");
    // 缺元素时返回的是真正的 no-op：调用两次不抛、也不登记解绑器。
    expect(() => {
      off();
      off();
    }).not.toThrow();
    expect(() => {
      host.destroy();
    }).not.toThrow();
  });
});

describe("destroy · 一次解绑全部监听", () => {
  it("should unbind everything on destroy", () => {
    const a = fakeElement("div");
    const b = fakeElement("div");
    const host = createDomHost(
      docWith([
        ["#a", a],
        ["#b", b],
      ]),
    );
    const offA = host.on("#a", "click", noop);
    host.on("#b", "change", noop);
    expect(offA).toBeTypeOf("function");
    host.destroy();
    expect(a.listeners).toEqual([]);
    expect(b.listeners).toEqual([]);
  });
});
