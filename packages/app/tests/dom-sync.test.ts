// 这层管：`dom.ts` 新增修复的 100% 覆盖——`stripHeadOf`（剥除 head 并同步 `#hr-theme`）、
// `<textarea>.value` 清空、原型链 `value`/`closest` 转发，`blockId` 预解析与 `syncBlocks`。

import { describe, expect, it } from "vitest";

import { createDomHost, type TargetLike } from "../src/dom.ts";
import {
  createFakeDocument,
  fakeElement,
  withBlocks,
  type FakeElement,
} from "./support/fake-dom.ts";

const blockOf = (tag: string, id: string, component?: string): FakeElement => {
  const el = fakeElement(tag);
  el.setAttribute("data-hr-id", id);
  if (component !== undefined) el.setAttribute("data-hr-component", component);
  return el;
};

describe("dom · stripHeadOf 与同步 #hr-theme", () => {
  it("should strip <head> and sync <style id=hr-theme> into #hr-theme once", () => {
    const doc = createFakeDocument();
    const docEl = fakeElement("article");
    const themeEl = fakeElement("style");
    doc.bySelector.set("#hr-doc", docEl);
    doc.bySelector.set("#hr-theme", themeEl);
    const fullHtml =
      '<!doctype html><html><head><style id="hr-theme">:root{--x:1}</style></head><body><article data-hr-id="doc-root"><p data-hr-id="a">hi</p></article></body></html>';
    const host = createDomHost(doc);
    host.html("#hr-doc", fullHtml);
    host.html("#hr-doc", fullHtml);
    expect(themeEl.textContent).toBe(":root{--x:1}");
    expect(docEl.innerHTML).toBe(
      '<article data-hr-id="doc-root"><p data-hr-id="a">hi</p></article>',
    );
  });

  it("should not treat an <article> literal inside the theme comment as the document start", () => {
    const doc = createFakeDocument();
    const docEl = fakeElement("article");
    doc.bySelector.set("#hr-doc", docEl);
    const fullHtml =
      '<head><style id="hr-theme">/* 形态（<article data-hr-kind="slides">）*/ a{}</style></head>' +
      '<body><article data-hr-id="doc-root"><p data-hr-id="a">hi</p></article></body>';
    createDomHost(doc).html("#hr-doc", fullHtml);
    expect(docEl.innerHTML).toBe(
      '<article data-hr-id="doc-root"><p data-hr-id="a">hi</p></article>',
    );
  });

  it("should keep in-article comments while skipping pre-article junk", () => {
    const doc = createFakeDocument();
    const docEl = fakeElement("article");
    doc.bySelector.set("#hr-doc", docEl);
    const fullHtml =
      "<!-- <article -->" +
      '<article data-hr-id="doc-root"><!-- keep --><p data-hr-id="a">hi</p></article>';
    createDomHost(doc).html("#hr-doc", fullHtml);
    expect(docEl.innerHTML).toBe(
      '<article data-hr-id="doc-root"><!-- keep --><p data-hr-id="a">hi</p></article>',
    );
  });

  it("should fall back to the raw markup when no unmasked <article> exists", () => {
    const doc = createFakeDocument();
    const docEl = fakeElement("article");
    docEl.innerHTML = '<article data-hr-id="doc-root"></article>';
    doc.bySelector.set("#hr-doc", docEl);
    // 唯一一处 `<article` 在 style 注释里 → 起点找不到 → 原样返回（既有兜底）。
    createDomHost(doc).html("#hr-doc", "<style>/* <article */</style>");
    expect(docEl.innerHTML).toBe("<style>/* <article */</style>");
    createDomHost(doc).html("#hr-doc", "<p>没有收尾标签</p><article");
    expect(docEl.innerHTML).toBe("<p>没有收尾标签</p><article");
  });

  it("should skip theme sync gracefully when #hr-theme element is missing", () => {
    const doc = createFakeDocument();
    doc.bySelector.set("#hr-doc", fakeElement("article"));
    createDomHost(doc).html(
      "#hr-doc",
      '<head><style id="hr-theme">a{}</style></head><article data-hr-id="r"></article>',
    );
    expect(doc.bySelector.get("#hr-doc")?.innerHTML).toBe('<article data-hr-id="r"></article>');
  });
});

describe("dom · textarea.value 与原型链 TargetLike", () => {
  it("should sync input/textarea .value only when it actually changed", () => {
    const doc = createFakeDocument();
    const ta = fakeElement("textarea");
    ta.value = "stale";
    doc.bySelector.set("#draft", ta);
    const host = createDomHost(doc);
    host.text("#draft", "");
    expect(ta.value).toBe("");
    host.text("#draft", "");
    expect(ta.value).toBe("");
  });

  it("should forward prototype-inherited value and closest along with blockId", () => {
    const val = "来自原型";
    class ProtoTarget implements TargetLike {
      get value(): string {
        return val;
      }
      closest(): { getAttribute: (name: string) => string | null } {
        return { getAttribute: () => "hr-b" };
      }
    }
    const doc = createFakeDocument();
    const area = fakeElement("textarea");
    doc.bySelector.set("#draft", area);
    let capturedValue: string | undefined;
    let capturedAttr: string | null | undefined;
    let capturedBlock: string | undefined;
    createDomHost(doc).on("#draft", "input", (target) => {
      capturedValue = target.value;
      capturedBlock = target.blockId;
      capturedAttr = target.closest?.("[data-hr-id]")?.getAttribute("data-hr-id") ?? null;
    });
    area.fire("input", new ProtoTarget());
    expect([capturedValue, capturedBlock, capturedAttr]).toEqual(["来自原型", "hr-b", "hr-b"]);
    area.fire("input", {});
    expect([capturedValue, capturedBlock]).toEqual([undefined, undefined]);
  });
});

describe("dom · syncBlocks · 新增/改标签/重排", () => {
  it("should insert new blocks, replace changed tags/components, and reorder existing blocks", () => {
    const doc = createFakeDocument();
    const article = fakeElement("article");
    const liveA = blockOf("p", "a");
    const liveB = blockOf("p", "b");
    const liveD = blockOf("div", "d", "kpi-bento");
    article.appendChild(liveB);
    article.appendChild(liveA);
    article.appendChild(liveD);
    doc.bySelector.set("#hr-doc article[data-hr-id]", article);
    doc.bySelector.set('[data-hr-id="a"]', liveA);
    doc.bySelector.set('[data-hr-id="b"]', liveB);
    doc.bySelector.set('[data-hr-id="d"]', liveD);
    const box = fakeElement("div");
    withBlocks(box, [
      blockOf("h2", "a"),
      blockOf("p", "b"),
      blockOf("p", "c"),
      blockOf("div", "d", "split-compare"),
    ]);
    doc.createElement = () => box;
    createDomHost(doc).syncBlocks?.("<article></article>");
    expect(liveA.calls).toContain("replaceWith");
    expect(liveD.calls).toContain("replaceWith");
    expect(article.children.map((node) => node.getAttribute("data-hr-id"))).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });
});

describe("dom · syncBlocks · 兜底与优先直接子节点", () => {
  it("should skip silently when #hr-doc container does not exist", () => {
    expect(() => {
      createDomHost(createFakeDocument()).syncBlocks?.("<p>x</p>");
    }).not.toThrow();
  });

  it("should prefer direct article children when available and fall back otherwise", () => {
    const doc = createFakeDocument();
    const container = fakeElement("div");
    const liveA = blockOf("p", "a");
    container.appendChild(liveA);
    doc.bySelector.set("#hr-doc", container);
    doc.bySelector.set('[data-hr-id="a"]', liveA);
    const directB = blockOf("p", "b");
    const box = fakeElement("div");
    box.querySelectorAll = (sel) => (sel.includes(">") ? [blockOf("p", "a"), directB] : []);
    doc.createElement = () => box;
    createDomHost(doc).syncBlocks?.(
      "<article data-hr-id=r><p data-hr-id=a></p><p data-hr-id=b></p></article>",
    );
    expect(container.children.map((node) => node.getAttribute("data-hr-id"))).toEqual(["a", "b"]);
  });
});
