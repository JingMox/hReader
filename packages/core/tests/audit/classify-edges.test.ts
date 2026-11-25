// 这层管：`classifyDocument` 在边缘文档上的三分类稳定性与互斥性——
// 每个断言都同时锁"分档"与"articles 计数"，两次调用必须逐字节同判。

import { describe, expect, it } from "vitest";

import { classifyDocument, loadDocument, parseHtml } from "../../src/index";
import type { Classification } from "../../src/index";

const cls = (html: string): Classification => classifyDocument(parseHtml(html));

/** 稳定性：同一输入连判两次结果全等；分档恒在三值之一。 */
const stable = (html: string): Classification => {
  const once = cls(html);
  const twice = cls(html);
  expect(twice).toEqual(once);
  expect(["managed", "normalizable", "foreign"]).toContain(once.cls);
  return once;
};

describe("classifyDocument · 空与骨架", () => {
  it.each([
    ["empty string", ""],
    ["whitespace only", "  \n\t  "],
    ["BOM only", "\uFEFF"],
    ["only doctype", "<!doctype html>"],
    ["doctype + empty html", "<!doctype html><html></html>"],
    ["head only, no body", "<!doctype html><html><head><title>t</title></head></html>"],
    ["comment only", "<!-- nothing -->"],
  ])("should classify %s as foreign with zero articles", (_name, html) => {
    const result = stable(html);

    expect(result.cls).toBe("foreign");
    expect(result.articles).toBe(0);
    expect(result.reason).toBeDefined();
  });
});

describe("classifyDocument · article 计数", () => {
  it("should count a bare article at top level (parser moves it into body)", () => {
    expect(stable('<article data-hr-id="a"><p>x</p></article>').cls).toBe("managed");
  });

  it("should count every article including nested and non-body placements", () => {
    expect(stable("<article>a<article>b</article></article>").articles).toBe(2);
    expect(
      stable('<body><div><article data-hr-id="a">x</article></div><article>y</article></body>')
        .articles,
    ).toBe(2);
  });

  it("should report foreign even when one of several articles has a valid id", () => {
    const result = stable('<article data-hr-id="a">x</article><article>y</article>');

    expect(result.cls).toBe("foreign");
    expect(result.articles).toBe(2);
  });
});

describe("classifyDocument · 伪装与怪形 id", () => {
  it("should treat a forged valid-shaped data-hr-id as managed (id presence is the whole test)", () => {
    // 外来文档伪造 `data-hr-id="root"`：classify 只看"article 上一个合法 id"，
    // 无从分辨真伪——这是既定口径，下游（normalize/patch）不再重复判。
    expect(stable('<article data-hr-id="root"><p>x</p></article>').cls).toBe("managed");
  });

  it.each([
    ["empty value", 'data-hr-id=""'],
    ["space inside", 'data-hr-id="a b"'],
    ["starts with digit", 'data-hr-id="1abc"'],
    ["too long", `data-hr-id="a${"b".repeat(64)}"`],
    ["illegal char", 'data-hr-id="a.b"'],
    ["unicode escape lookalike", 'data-hr-id="a\\u0041"'],
  ])("should classify article with %s as normalizable", (_name, attr) => {
    expect(stable(`<article ${attr}><p>x</p></article>`).cls).toBe("normalizable");
  });

  it("should keep normalizable when the attribute is present but value-less", () => {
    expect(stable("<article data-hr-id><p>x</p></article>").cls).toBe("normalizable");
  });

  it("should read the first value when data-hr-id is duplicated on the article", () => {
    // parse5 对重复属性保第一个：第一个合法 → managed；第一个非法 → normalizable。
    expect(
      stable('<article data-hr-id="good" data-hr-id="bad id"><p>x</p></article>').cls,
    ).toBe("managed");
    expect(
      stable('<article data-hr-id="bad id" data-hr-id="good"><p>x</p></article>').cls,
    ).toBe("normalizable");
  });
});

describe("classifyDocument · 惰性/外来内容里的 article", () => {
  it("should count an article inside <template> (inert content still counts)", () => {
    // 现状口径：树遍历进 template.content，惰性 article 也计入。
    // `<template><article>` 的外来页会被判 normalizable/managed 而不是 foreign——记录现行行为。
    expect(stable("<template><article>x</article></template>").cls).toBe("normalizable");
    expect(stable('<template><article data-hr-id="a">x</article></template>').cls).toBe(
      "managed",
    );
  });

  it("should count an article inside <noscript> (scripting-disabled parse)", () => {
    expect(stable('<noscript><article data-hr-id="a">x</article></noscript>').cls).toBe(
      "managed",
    );
  });

  it("should count a tag named article inside <svg> foreign content", () => {
    // `<svg><article>` 不是 HTML 的 article（article 不在 foreign breakout 名单），
    // 但本树没有命名空间信息，tag 匹配即计入——记录现行行为。
    expect(stable('<svg><article data-hr-id="a"></article></svg>').cls).toBe("managed");
  });

  it("should ignore an article tag inside a frameset document (parser drops it)", () => {
    const result = stable("<frameset><article>x</article></frameset>");

    expect(result.cls).toBe("foreign");
    expect(result.articles).toBe(0);
  });
});

describe("classifyDocument · 大文档与 loadDocument 一致性", () => {
  it("should classify a large document with the article at the end", () => {
    const padding = `<div>${"<p>填充</p>".repeat(200)}</div>`.repeat(40);
    const result = stable(`${padding}<article data-hr-id="a"><p>x</p></article>`);

    expect(result.cls).toBe("managed");
    expect(result.articles).toBe(1);
  });

  it("should agree with loadDocument: managed ⇒ derive succeeds, others ⇒ ok:false", () => {
    const managed = parseHtml('<article data-hr-id="a"><p>x</p></article>');
    const normalizable = parseHtml("<article><p>x</p></article>");
    const foreign = parseHtml("<p>x</p>");

    expect(loadDocument(managed).ok).toBe(true);
    expect(loadDocument(normalizable)).toMatchObject({
      ok: false,
      classification: { cls: "normalizable" },
    });
    expect(loadDocument(foreign)).toMatchObject({
      ok: false,
      classification: { cls: "foreign" },
    });
  });

  it("should keep the load gate consistent for every cls value", () => {
    for (const html of [
      '<article data-hr-id="a">x</article>',
      "<article>x</article>",
      "<p>x</p>",
      "<article>a</article><article>b</article>",
      "",
    ]) {
      const parsed = parseHtml(html);
      const load = loadDocument(parsed);
      expect(load.ok).toBe(classifyDocument(parsed).cls === "managed");
    }
  });
});
