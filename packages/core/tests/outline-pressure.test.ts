// 这层管：诊断/体积压力的边界路径 —— 去折叠、按 code 限额、三级收敛、容器缺 id、注释节点。
// 这些用例不是"凑覆盖率"：每一条都对应 `diagnostics.ts` / `budget.ts` / `walk.ts` 里一个具体分支，
// 断言的仍是**用户可见**的结果（诊断条数、报文里的规模、截断只报一条）。

import { describe, expect, it } from "vitest";

import { buildOutline, parseHtml } from "../src/index";
import type { Outline } from "../src/index";

const outlineOf = (html: string): Outline => buildOutline(parseHtml(html));

const codesOf = (outline: Outline): readonly string[] =>
  outline.diagnostics.map((diagnostic) => diagnostic.code);

const article = (body: string): string => `<article data-hr-id="doc">${body}</article>`;

describe("hr_outline · 诊断限额与去折叠", () => {
  it("should report a container without data-hr-id (not only headings)", () => {
    const outline = outlineOf(article('<section><h2 data-hr-id="a">标题</h2></section>'));

    expect(codesOf(outline)).toContain("outline_node_without_id");
    expect(outline.diagnostics[0]?.message).toContain("<section>");
  });

  it("should walk comment nodes without treating them as elements", () => {
    const outline = outlineOf(article('<!-- 注释 --><h2 data-hr-id="a">标题</h2>'));

    expect(outline.nodes.map((node) => node.id)).toEqual(["a"]);
    expect(codesOf(outline)).toEqual([]);
  });

  it("should keep at most three entries per code and say how many were folded", () => {
    const outline = outlineOf(
      article("<section><p>x</p></section><header><p>y</p></header><h2>a</h2><h3>b</h3>"),
    );
    const truncated = outline.diagnostics.filter((item) => item.code === "outline_truncated");

    expect(truncated.length).toBe(1);
    expect(truncated[0]?.message).toContain("另有");
    expect(codesOf(outline).filter((code) => code === "outline_node_without_id").length).toBe(3);
  });
});
describe("hr_outline · 诊断限额与去折叠 · 续 1", () => {
  it("should fall back to one entry per code when even three exceed the byte limit", () => {
    const longTarget = "t".repeat(600);
    const meta = JSON.stringify({
      annotations: [
        { id: "a1", targetId: `${longTarget}1`, comment: "c", status: "pending_ai" },
        { id: "a2", targetId: `${longTarget}2`, comment: "c", status: "pending_ai" },
      ],
    });
    const outline = outlineOf(
      article(`<script id="hr-meta">${meta}</script><section><p>x</p></section>`),
    );
    const totalBytes = JSON.stringify(outline.diagnostics).length;

    expect(totalBytes).toBeLessThanOrEqual(1024);
    expect(codesOf(outline)).toContain("outline_truncated");
  });
});

describe("hr_outline · 诊断报文规模", () => {
  it("should count omitted diagnostics in the truncation message", () => {
    const outline = outlineOf(
      article("<section><p>x</p></section><header><p>y</p></header><h2>a</h2><h3>b</h3>"),
    );
    const [truncated] = outline.diagnostics.filter((item) => item.code === "outline_truncated");

    expect(truncated?.message).toMatch(/另有 \d+ 条诊断省略（outline_node_without_id \d+ 条）$/u);
  });
});

describe("hr_outline · 三级收敛（最严一级）", () => {
  it("should keep only the truncation report when a single entry exceeds the byte limit", () => {
    const meta = JSON.stringify({
      annotations: [{ id: "a1", targetId: "x".repeat(2_000), comment: "c", status: "pending_ai" }],
    });
    const outline = outlineOf(article(`<script id="hr-meta">${meta}</script><p>正文</p>`));

    expect(codesOf(outline)).toContain("outline_truncated");
    expect(JSON.stringify(outline.diagnostics).length).toBeLessThanOrEqual(2048);
  });
});

describe("hr_outline · 层级继承", () => {
  // Pinned current behavior: an inner section with no heading of its own inherits the
  // parent's level=2 but an empty text (it does not inherit the parent's heading text).
  // The spec only says "a section takes its first heading" and is silent on whether a
  // heading-less section inherits the parent's text, so this pins the implementation as-is.
  it("should let an inner untitled section inherit the outer section's level", () => {
    const outline = outlineOf(
      article(
        '<section data-hr-id="outer"><h2 data-hr-id="h">外层标题</h2><section data-hr-id="inner"><p>x</p></section></section>',
      ),
    );
    const outer = outline.nodes[0];

    expect(outer?.level).toBe(2);
    expect(outer?.children.map((child) => [child.id, child.level, child.text])).toEqual([
      ["h", 2, "外层标题"],
      ["inner", 2, ""],
    ]);
  });
});
