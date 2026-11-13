// 这层管：`lintByStyle` 的命中形状与文档序（偏移语义另见 lint-offset，限流另见 lint-limit）。

import { describe, expect, it } from "vitest";

import type { DocumentModel } from "../../src/model";
import { lintByStyle } from "../../src/style/lint";

const VOCAB = (forbidden: readonly string[], recommended: readonly string[] = []) => ({
  forbidden,
  recommended,
});

const node = (
  id: string,
  text: string,
  children: readonly DocumentModel[] = [],
): DocumentModel => ({ id, tag: "p", text, children });

describe("lintByStyle · 命中形状", () => {
  it("should report path, word, excerpt and offset for a single hit", () => {
    const report = lintByStyle([node("n1", "我们要赋能业务")], VOCAB(["赋能"]));

    expect(report).toEqual({
      hits: [{ path: "n1", word: "赋能", excerpt: "我们要赋能业务", offset: 3 }],
      truncated: false,
    });
  });

  it("should report every occurrence of one word, in order", () => {
    const report = lintByStyle([node("n1", "赋能，再赋能")], VOCAB(["赋能"]));

    expect(report.hits.map((hit) => hit.offset)).toEqual([0, 4]);
    expect(report.truncated).toBe(false);
  });

  it("should order hits by offset, then by vocabulary order at a tie", () => {
    const report = lintByStyle([node("n1", "抓手赋能")], VOCAB(["赋能", "抓手"]));

    expect(report.hits.map((hit) => [hit.word, hit.offset])).toEqual([
      ["抓手", 0],
      ["赋能", 2],
    ]);
  });

  it("should sort a mixed set of tied and distinct offsets", () => {
    const report = lintByStyle([node("n1", "赋能抓手赋能")], VOCAB(["赋能", "抓手"]));

    expect(report.hits.map((hit) => [hit.word, hit.offset])).toEqual([
      ["赋能", 0],
      ["抓手", 2],
      ["赋能", 4],
    ]);
  });
});

describe("lintByStyle · 文档序与极端形状", () => {
  it("should walk children before the sibling that follows them (document order)", () => {
    const tree = [
      node("a", "顶层", [node("a1", "子块一赋能"), node("a2", "子块二")]),
      node("b", "尾块赋能"),
    ];

    expect(lintByStyle(tree, VOCAB(["赋能"])).hits.map((hit) => hit.path)).toEqual(["a1", "b"]);
  });

  it("should not recurse on a 3000-deep model tree", () => {
    let deep = node("leaf", "深处赋能");
    for (let index = 0; index < 3000; index += 1) deep = node(`n${String(index)}`, "", [deep]);

    expect(lintByStyle([deep], VOCAB(["赋能"])).hits).toEqual([
      expect.objectContaining({ path: "leaf", offset: 2 }),
    ]);
  });

  it("should return no hits for an empty vocabulary or an empty document", () => {
    expect(lintByStyle([node("n1", "赋能")], VOCAB([]))).toEqual({ hits: [], truncated: false });
    expect(lintByStyle([], VOCAB(["赋能"]))).toEqual({ hits: [], truncated: false });
  });
});

describe("lintByStyle · 摘录窗口", () => {
  it("should not prepend an ellipsis when the hit starts near the block start", () => {
    const hit = lintByStyle([node("n1", "禁用后面还有很多很多文字")], VOCAB(["禁用"])).hits[0];

    expect(hit?.excerpt).toBe("禁用后面还有很多很多文字");
  });

  it("should ellipsize on both sides for a hit in the middle of a long block", () => {
    const text = `${"前".repeat(40)}禁用${"后".repeat(40)}`;
    const hit = lintByStyle([node("n1", text)], VOCAB(["禁用"])).hits[0];

    expect(hit?.excerpt).toBe(`…${"前".repeat(16)}禁用${"后".repeat(16)}…`);
    expect(hit?.offset).toBe(40);
  });

  it("should keep the excerpt within the block boundaries", () => {
    const hit = lintByStyle([node("n1", "末尾禁用")], VOCAB(["禁用"])).hits[0];

    expect(hit?.excerpt).toBe("末尾禁用");
    expect(hit?.excerpt.endsWith("…")).toBe(false);
  });
});
