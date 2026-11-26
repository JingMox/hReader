import { describe, expect, it } from "vitest";

import { injectNodeIds, parseHtml } from "../src/index";
import type { HtmlNode } from "../src/html/constants";

// `<article>` 自身也是注入目标（模型根 ID 不得为空）。这里单独钉住它的边界：
// 只注入最外层、已有合法 ID 原样保留、非法 ID 重注入、嵌套 article 不重复处理、可重复。

const HR_ID = "data-hr-id";

const walkNodes = (root: HtmlNode): readonly HtmlNode[] => {
  const seen: HtmlNode[] = [];
  const stack: HtmlNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) {
      break;
    }
    seen.push(node);
    const children = node.kind === "element" || node.kind === "document" ? node.children : [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) {
        stack.push(child);
      }
    }
  }
  return seen;
};

const hrIdOf = (html: string, tag: string): readonly string[] =>
  walkNodes(injectNodeIds(parseHtml(html)).parsed.root).flatMap((node) => {
    if (node.kind !== "element" || node.tag !== tag) {
      return [];
    }
    const value = node.attrs.find(([name]) => name === HR_ID)?.[1];
    return value === undefined ? [] : [value];
  });

const IDs = /^hr-[0-9a-f]{8}$/u;

describe("injectNodeIds · article 自身", () => {
  it("should inject exactly one id on a document with a single article", () => {
    const injected = injectNodeIds(parseHtml("<article><p>a</p></article>"));

    expect(hrIdOf("<article><p>a</p></article>", "article")).toHaveLength(1);
    expect(injected.injected).toHaveLength(2);
  });

  it("should keep an article id that is already legal", () => {
    const html = `<article ${HR_ID}="doc"><p>a</p></article>`;

    expect(hrIdOf(html, "article")).toEqual(["doc"]);
    expect(injectNodeIds(parseHtml(html)).injected).toHaveLength(1);
  });

  it("should re-inject an illegal article id and never leave it empty", () => {
    const ids = hrIdOf(`<article ${HR_ID}="Bad Id"><p>a</p></article>`, "article");

    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(IDs);
  });

  it("should not inject inside a nested article (only the outermost one)", () => {
    const ids = hrIdOf(
      `<article ${HR_ID}="doc"><article ${HR_ID}="inner">x</article></article>`,
      "article",
    );

    expect(ids).toEqual(["doc", "inner"]);
  });

  it("should never rewrite ids that are already unique and legal", () => {
    const html = `<article ${HR_ID}="doc"><p ${HR_ID}="a">1</p><p ${HR_ID}="b">2</p></article>`;

    expect(hrIdOf(html, "p")).toEqual(["a", "b"]);
    expect(injectNodeIds(parseHtml(html)).injected).toEqual([]);
  });
});

describe("injectNodeIds · article 自身 · 续", () => {
  it("should be deterministic for the same input", () => {
    const html = "<article><h2>t</h2><p>a</p></article>";

    expect(injectNodeIds(parseHtml(html)).injected).toEqual(
      injectNodeIds(parseHtml(html)).injected,
    );
    expect(injectNodeIds(parseHtml(html)).injected.length).toBeGreaterThan(0);
  });

  it("should still work when the article is the only node", () => {
    expect(hrIdOf("<article></article>", "article")).toEqual([expect.stringMatching(IDs)]);
  });
});
