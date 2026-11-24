// 这层管：`classifyDocument` 的三档划分——managed / normalizable / foreign（含 articles 计数与 reason 文案）。

import { describe, expect, it } from "vitest";

import { classifyDocument, parseHtml, type Classification } from "../src/index";

const classifyOf = (html: string): Classification => classifyDocument(parseHtml(html));

describe("classifyDocument · managed", () => {
  it("should report managed when the single article carries a valid data-hr-id", () => {
    expect(classifyOf('<article data-hr-id="hr-a"><p>正文</p></article>')).toEqual({
      cls: "managed",
      articles: 1,
    });
  });

  it("should stay managed when the article has children without ids", () => {
    expect(classifyOf('<article data-hr-id="hr-a"><p><span>x</span></p></article>').cls).toBe(
      "managed",
    );
  });
});

describe("classifyDocument · normalizable", () => {
  it("should report normalizable when the single article lacks data-hr-id", () => {
    expect(classifyOf("<article><p>a</p></article>")).toEqual({
      cls: "normalizable",
      articles: 1,
    });
  });

  it("should report normalizable when data-hr-id is present but malformed", () => {
    expect(classifyOf('<article data-hr-id="9bad"><p>a</p></article>').cls).toBe("normalizable");
  });
});

describe("classifyDocument · foreign", () => {
  it("should report foreign with a reason when there is no article at all", () => {
    const result = classifyOf(
      '<!doctype html><html><body><div class="app"><script>window.x=1</script></div></body></html>',
    );

    expect(result.cls).toBe("foreign");
    expect(result.articles).toBe(0);
    expect(result.reason).toContain("<article>");
  });

  it("should report foreign when the page has multiple articles (legal HTML, not corruption)", () => {
    const result = classifyOf(
      '<article data-hr-id="hr-a">a</article><article data-hr-id="hr-b">b</article>',
    );

    expect(result.cls).toBe("foreign");
    expect(result.articles).toBe(2);
    expect(result.reason).toContain("2");
  });

  it("should report foreign for nested articles too", () => {
    expect(classifyOf("<article><article><p>a</p></article></article>").articles).toBe(2);
  });
});
