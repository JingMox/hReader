// This layer covers `annotator/text-model`'s DOM text domain — text-node
// concatenation, skipped subtrees, the (node,offset) ↔ body-text offset mapping
// in both directions, and the selector-path grammar with its limits.
// The DOM comes from happy-dom; odd shapes (a localName outside the grammar)
// are filled in with minimal structural fakes.

import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import type { DomElementLike, DomNodeLike } from "../src/annotator/shapes.ts";
import { domBodyMapOf, elementOfPoint, insideBody } from "../src/annotator/text-model.ts";

const EL = (value: unknown): DomElementLike => value as DomElementLike;
const ND = (value: unknown): DomNodeLike => value as DomNodeLike;

const bodyOf = (html: string) => {
  const win = new Window();
  win.document.body.innerHTML = html;
  const dom = win.document.body;
  return { win, dom, body: dom as unknown as DomElementLike };
};

const textOf = (html: string): string => domBodyMapOf(bodyOf(html).body).text;

describe("annotator text-model · body text", () => {
  it("should concatenate text nodes in document order", () => {
    expect(textOf(`<p>ab<span>cd</span>ef</p><div>gh<i>ij</i></div>`)).toBe("abcdefghij");
  });

  it("should skip script, style, template, noscript and the hr-meta script", () => {
    expect(
      textOf(
        `<p>a<script>var x=1;</script><style>.y{}</style>b</p>` +
          `<template><p>t</p></template><noscript><p>n</p></noscript>` +
          `<script id="hr-meta">{"m":1}</script><p>c</p>`,
      ),
    ).toBe("abc");
    // Parity with core: only the four tags are skipped — a NON-script element
    // carrying the hr-meta id is foreign markup and its text counts.
    expect(textOf(`<p>a</p><div id="hr-meta"><p>m</p></div><p>c</p>`)).toBe("amc");
  });

  it("should keep entities decoded and whitespace verbatim", () => {
    expect(textOf(`<p>a &amp; b&nbsp;c</p>`)).toBe("a & b c");
  });
});

describe("annotator text-model · offsetOfPoint", () => {
  it("should map a text node offset into the body text", () => {
    const { dom, body } = bodyOf(`<p>ab<span>cd</span>ef</p>`);
    const map = domBodyMapOf(body);
    const spanText = ND(dom.querySelector("span")?.firstChild);
    expect(map.offsetOfPoint(spanText, 0)).toBe(2);
    expect(map.offsetOfPoint(spanText, 2)).toBe(4);
    // offset past the node length clamps to the node end.
    expect(map.offsetOfPoint(spanText, 99)).toBe(4);
  });

  it("should accumulate child contributions for element offsets", () => {
    const { dom, body } = bodyOf(`<p>ab<b>cd</b>ef<!--c--></p>`);
    const map = domBodyMapOf(body);
    const p = EL(dom.querySelector("p"));
    expect(map.offsetOfPoint(p, 0)).toBe(0); // before "ab"
    expect(map.offsetOfPoint(p, 1)).toBe(2); // after the text, before <b>
    expect(map.offsetOfPoint(p, 2)).toBe(4); // after <b>, before "ef"
    expect(map.offsetOfPoint(p, 4)).toBe(6); // after text + comment
    expect(map.offsetOfPoint(p, 99)).toBe(6); // clamp to the span end
    expect(map.spanOf(p)).toEqual({ start: 0, end: 6 });
  });

  it("should return undefined for nodes outside the counted domain", () => {
    const { win, dom, body } = bodyOf(`<p>a<script>var x;</script>b</p>`);
    const map = domBodyMapOf(body);
    expect(map.offsetOfPoint(ND(win.document.createTextNode("x")), 0)).toBeUndefined();
    expect(map.offsetOfPoint(ND(win.document.createElement("div")), 0)).toBeUndefined();
    const comment = dom.querySelector("p")?.lastChild;
    if (comment?.nodeType === 8) {
      expect(map.offsetOfPoint(ND(comment), 0)).toBeUndefined();
    }
    const scriptText = dom.querySelector("script")?.firstChild;
    if (scriptText !== null && scriptText !== undefined) {
      expect(map.offsetOfPoint(ND(scriptText), 0)).toBeUndefined();
    }
  });
});

describe("annotator text-model · pointAt", () => {
  it("should map body-text offsets back to DOM points", () => {
    const { dom, body } = bodyOf(`<p>ab<span>cd</span>ef</p>`);
    const map = domBodyMapOf(body);
    const p = dom.querySelector("p");
    const firstText = p?.firstChild;
    const spanText = p?.querySelector("span")?.firstChild;

    expect(map.pointAt(0)).toEqual({ node: firstText, offset: 0 });
    expect(map.pointAt(1)).toEqual({ node: firstText, offset: 1 });
    // a boundary lands at "the end of the previous node" — a legal Range position.
    expect(map.pointAt(2)).toEqual({ node: firstText, offset: 2 });
    expect(map.pointAt(3)).toEqual({ node: spanText, offset: 1 });
    // text.length → the end of the last text node.
    expect(map.pointAt(6)).toEqual({ node: p?.lastChild, offset: 2 });
  });

  it("should return undefined out of range or without text", () => {
    const { body } = bodyOf(`<p>ab</p>`);
    const map = domBodyMapOf(body);
    expect(map.pointAt(-1)).toBeUndefined();
    expect(map.pointAt(3)).toBeUndefined();

    const empty = domBodyMapOf(bodyOf(``).body);
    expect(empty.text).toBe("");
    expect(empty.pointAt(0)).toBeUndefined();
  });
});

describe("annotator text-model · selectorOf", () => {
  it("should build core-grammar paths", () => {
    const { dom, body } = bodyOf(`<div><p>a</p></div><div><p>b</p><p>c</p><p><i>d</i></p></div>`);
    const map = domBodyMapOf(body);
    expect(map.selectorOf(body)).toBe("body");
    const target = dom
      .querySelectorAll("div")
      .item(1)
      ?.querySelectorAll("p")
      .item(2)
      ?.querySelector("i");
    expect(target).not.toBeUndefined();
    expect(map.selectorOf(EL(target))).toBe("body > div:nth-of-type(2) > p:nth-of-type(3) > i");
    const firstDiv = EL(dom.querySelector("div"));
    expect(map.selectorOf(firstDiv)).toBe("body > div");
  });

  it("should return undefined for elements not under body", () => {
    const { win, body } = bodyOf(`<p>a</p>`);
    const map = domBodyMapOf(body);
    const detachedDom = win.document.createElement("div");
    const detached = EL(detachedDom);
    expect(map.selectorOf(detached)).toBeUndefined();
    // A child of a detached subtree fails through the recursive prefix.
    detachedDom.appendChild(win.document.createElement("p"));
    const nested = detachedDom.children.item(0);
    expect(map.selectorOf(EL(nested))).toBeUndefined();
  });

  it("should return undefined over the step limit", () => {
    const depth = 70;
    const html = "<div>".repeat(depth) + "x" + "</div>".repeat(depth);
    const { dom, body } = bodyOf(html);
    const map = domBodyMapOf(body);
    let deepest = dom.querySelector("div");
    while (deepest !== null) {
      const next = deepest.querySelector("div");
      if (next === null) break;
      deepest = next;
    }
    expect(map.selectorOf(EL(deepest))).toBeUndefined();
  });

  it("should return undefined over the char limit but under the step limit", () => {
    const tag = "x-abcdefghij-klmnopqrst-uvwxyz-0123456789";
    const depth = 30;
    const html = `<${tag}>`.repeat(depth) + "x" + `</${tag}>`.repeat(depth);
    const { dom, body } = bodyOf(html);
    const map = domBodyMapOf(body);
    let deepest = dom.querySelector(tag);
    while (deepest !== null) {
      const next = deepest.querySelector(tag);
      if (next === null) break;
      deepest = next;
    }
    // 30 steps × ~40 chars ≈ 1.2k chars → over 1024 while under 64 steps.
    expect(map.selectorOf(EL(deepest))).toBeUndefined();
  });

  it("should return undefined over the nth-of-type limit", () => {
    const { dom, body } = bodyOf(`<div>${"<i></i>".repeat(10_001)}</div>`);
    const map = domBodyMapOf(body);
    const last = dom.querySelectorAll("i").item(10_000);
    expect(last).not.toBeNull();
    expect(map.selectorOf(EL(last))).toBeUndefined();
  });

  it("should return undefined when the tag does not fit the grammar", () => {
    const { body } = bodyOf(`<p>a</p>`);
    const map = domBodyMapOf(body);
    const weird = EL({ localName: "x_y", parentElement: body });
    expect(map.selectorOf(weird)).toBeUndefined();
    // CamelCase foreign-content tags parse but can never resolve: emit nothing.
    const foreign = EL({ localName: "foreignObject", parentElement: body });
    expect(map.selectorOf(foreign)).toBeUndefined();
  });
});

describe("annotator text-model · offsetOfPoint domain edges", () => {
  it("should reject nodes outside the counted domain", () => {
    const { win, dom, body } = bodyOf(`<p>ab</p>`);
    const map = domBodyMapOf(body);
    const comment = win.document.createComment("c");
    dom.appendChild(comment);
    // nodeType 8: neither text nor element → outside the domain.
    expect(map.offsetOfPoint(ND(comment), 0)).toBeUndefined();
    // Detached text / element: never indexed, no span.
    expect(map.offsetOfPoint(ND(win.document.createTextNode("x")), 0)).toBeUndefined();
    expect(map.offsetOfPoint(ND(win.document.createElement("div")), 0)).toBeUndefined();
  });

  it("should treat skipped or post-map children as zero-width", () => {
    const { win, dom, body } = bodyOf(`<p>a<script>var x=1;</script></p>`);
    const p = dom.querySelector("p");
    const map = domBodyMapOf(body);
    // children: [text "a", script] — the skipped script contributes 0.
    expect(map.offsetOfPoint(EL(p), 2)).toBe(1);
    // A text node appended after the map was built is unindexed → +0.
    if (p !== null) p.appendChild(win.document.createTextNode("late"));
    expect(map.offsetOfPoint(EL(p), 3)).toBe(1);
  });
});

describe("annotator text-model · insideBody / elementOfPoint", () => {
  it("should detect membership through the parent chain", () => {
    const { win, dom, body } = bodyOf(`<p>a<b>c</b></p>`);
    const text = ND(dom.querySelector("b")?.firstChild);
    expect(insideBody(body, text)).toBe(true);
    expect(insideBody(body, body)).toBe(true);
    expect(insideBody(body, ND(win.document.createElement("div")))).toBe(false);
  });

  it("should resolve the element a boundary hangs on", () => {
    const { win, dom } = bodyOf(`<p>a<b>c</b></p>`);
    const b = EL(dom.querySelector("b"));
    expect(elementOfPoint(b)).toBe(b);
    expect(elementOfPoint(ND(dom.querySelector("b")?.firstChild))).toBe(b);
    const detached = ND(win.document.createTextNode("x"));
    expect(elementOfPoint(detached)).toBeUndefined();
  });
});
