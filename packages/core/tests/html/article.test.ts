// 这层管：`hasArticle` 这个"这是不是一篇文档"的最小判据——它只看标签，不看 id、不看结构。
//
// 两种"不是文档"要走两个码：缺 id 一条命令能修（`hr normalize`），缺 `<article>` 修不了。

import { describe, expect, it } from "vitest";

import { hasArticle } from "../../src/html/article";
import { parseHtml } from "../../src/html/parse";

const articleOf = (html: string): boolean => hasArticle(parseHtml(html));

describe("hasArticle · 只看标签", () => {
  it("should find <article> even when it carries no id at all", () => {
    expect(articleOf("<article><p>x</p></article>")).toBe(true);
    // id 不影响"这是不是文档"：带不带 `data-hr-id` 都是 true。
    expect(articleOf('<article data-hr-id="hr-a"><p>x</p></article>')).toBe(true);
  });

  it("should say no when the file is not a document", () => {
    expect(articleOf("<!doctype html><html><body><p>随手记一段</p></body></html>")).toBe(false);
    expect(articleOf("")).toBe(false);
  });
});
