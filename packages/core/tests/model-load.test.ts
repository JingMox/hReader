// 这层管：`loadDocument` 的两个分支——托管带模型 / 非托管只带分档；断言不抛异常。

import { describe, expect, it } from "vitest";

import { loadDocument, parseHtml } from "../src/index";

describe("loadDocument", () => {
  it("should return the derived model when the document is managed", () => {
    const load = loadDocument(
      parseHtml('<article data-hr-id="hr-a"><p data-hr-id="hr-b">正文</p></article>'),
    );

    expect(load.ok).toBe(true);
    if (!load.ok) throw new Error("unreachable: managed doc must load");
    expect(load.cls).toBe("managed");
    expect(load.model.tag).toBe("article");
    expect(load.model.children.map((node) => node.id)).toEqual(["hr-b"]);
  });

  it("should return the classification without throwing when the document is foreign", () => {
    const load = loadDocument(parseHtml("<div><p>没有 article</p></div>"));

    expect(load).toEqual({
      ok: false,
      classification: {
        cls: "foreign",
        articles: 0,
        reason: "文档里没有 <article>：按外来 HTML 原样展示，不能按块编辑",
      },
    });
  });

  it("should return the classification without throwing when the document is normalizable", () => {
    const load = loadDocument(parseHtml("<article><p>a</p></article>"));

    expect(load.ok).toBe(false);
    if (load.ok) throw new Error("unreachable: normalizable doc has no model");
    expect(load.classification.cls).toBe("normalizable");
    expect(load.classification.reason).toBeUndefined();
  });
});
