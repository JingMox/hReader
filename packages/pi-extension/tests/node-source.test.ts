// 这层管：`nodeSliceOf`——从 `/s/:docId` 的源文件字节里切出一个节点的源码（core 没有 readNode 路由，
// 批注引流与 `hreader_read_node` 都靠它）。同名标签嵌套时按深度配对，不能拿第一个 `</p>` 收尾。

import { describe, expect, it } from "vitest";

import { nodeSliceOf } from "../pi-hreader.ts";

const DOC =
  '<article data-hr-id="root">' +
  '<section data-hr-id="s1">' +
  '<p data-hr-id="p1">外层<p data-hr-id="p2">内层</p>尾巴</p>' +
  '<img data-hr-id="i1" src="a.png">' +
  '<br data-hr-id="b1">' +
  "<span data-hr-id='q1'>单引号</span>" +
  "</section>" +
  "</article>";

describe("nodeSliceOf 的配对", () => {
  it("同名标签嵌套时按深度配对（内层的 `</p>` 不能当外层的收尾）", () => {
    expect(nodeSliceOf(DOC, "p1")).toBe(
      '<p data-hr-id="p1">外层<p data-hr-id="p2">内层</p>尾巴</p>',
    );
  });

  it("内层节点独立可切", () => {
    expect(nodeSliceOf(DOC, "p2")).toBe('<p data-hr-id="p2">内层</p>');
  });

  it("自闭合/空元素不带收尾标签", () => {
    expect(nodeSliceOf(DOC, "i1")).toBe('<img data-hr-id="i1" src="a.png">');
    expect(nodeSliceOf(DOC, "b1")).toBe('<br data-hr-id="b1">');
  });

  it("属性用单引号也认", () => {
    expect(nodeSliceOf(DOC, "q1")).toBe("<span data-hr-id='q1'>单引号</span>");
  });

  it("`root` 换成整篇 `<article>`（core 的 patch 里 root 也是这个含义）", () => {
    expect(nodeSliceOf(DOC, "root")?.startsWith('<article data-hr-id="root">')).toBe(true);
    expect(nodeSliceOf(DOC, "root")?.endsWith("</article>")).toBe(true);
  });

  it("节点不存在 → undefined（由调用方给出 node_not_found）", () => {
    expect(nodeSliceOf(DOC, "nope")).toBeUndefined();
  });
});

describe("nodeSliceOf 的截断边界", () => {
  it("标签没闭合 → undefined，不返回半截源码", () => {
    expect(nodeSliceOf('<p data-hr-id="p1">没有收尾', "p1")).toBeUndefined();
  });

  it("收尾标签后没有 `>`（源文件截断在半写状态）→ undefined，不是空串源码", () => {
    // 曾经 `indexOf` 未命中返回 -1、`-1 + 1` 得 0，`slice(open, 0)` 得到空串被当成有效源码。
    expect(nodeSliceOf('<p data-hr-id="p1">x</p', "p1")).toBeUndefined();
  });

  it("没有 `<article>` 时 `root` → undefined", () => {
    expect(nodeSliceOf("<div>no article</div>", "root")).toBeUndefined();
  });
});
