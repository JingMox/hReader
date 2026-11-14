// 这层管：`spanOf`（`packages/core/src/html/span.ts`）——元素源码区间的单一存在性判据。
// 三条臂都要真跑：有区间 / 元素在但没有 `span`（→ 零宽 `ZERO_SPAN`）/ 元素不存在（→ `null`）。
// `null` 只表示"元素不存在"；"元素在但位置是零宽"必须由调用点自己判 `span.end <= span.start`。

import { describe, expect, it } from "vitest";

import type { HtmlElementNode, HtmlNode } from "../../src/html/constants";
import { parseHtml } from "../../src/html/parse";
import { spanOf } from "../../src/html/span";

const HTML = "<article><p>一</p></article>";

const elementsOf = (node: HtmlNode): HtmlElementNode[] => {
  const found: HtmlElementNode[] = [];
  const walk = (current: HtmlNode): void => {
    if (current.kind === "element") {
      found.push(current);
      for (const child of current.children) walk(child);
      return;
    }
    if (current.kind === "document") {
      for (const child of current.children) walk(child);
    }
  };
  walk(node);
  return found;
};

const articleOf = (locations = true): HtmlElementNode => {
  const [article] = elementsOf(parseHtml(HTML, { locations }).root).filter(
    (element) => element.tag === "article",
  );
  if (article === undefined) throw new Error("解析树里没有 <article>");
  return article;
};

describe("spanOf · 三种输入", () => {
  it("should return the span of an element parsed with locations", () => {
    const article = articleOf();

    const span = spanOf(article);

    // 区间是**源码坐标**：整棵树的 `<article>` 必然覆盖 `[0, HTML.length)`。
    expect(span).toStrictEqual(article.span);
    expect(span.start).toBe(0);
    expect(span.end).toBe(HTML.length);
  });

  it("should return a zero-width span for an element without a span", () => {
    // `locations: false` 的树**根本没有** `span` 字段（`span?: SourceSpan`）：元素在，所以答案是零宽，
    // 不是 `null`——`null` 被保留给"元素不存在"，否则调用点会把"零宽"误当成"没有这个元素"。
    const bare = articleOf(false);
    expect(bare).not.toHaveProperty("span");

    expect(spanOf(bare)).toStrictEqual({ start: 0, end: 0, innerStart: 0, innerEnd: 0 });
  });

  it("should return null when the element is missing", () => {
    // 调用点常用 `.at(-1)`：没有这个元素时不能抛。
    expect(spanOf(undefined)).toBeNull();
  });
});
