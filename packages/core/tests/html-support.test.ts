// 测试工具自检：工具本身出错会让所有依赖它的用例一起失真。

import { describe, expect, it } from "vitest";

import { parseHtml } from "../src/index";
import type { HtmlNode } from "../src/index";
import {
  childrenOf,
  findElement,
  collectElements,
  requireElement,
  attributeValue,
  callWithUnknown,
  catchThrown,
} from "./html-support";

describe("测试工具自检", () => {
  it("should find nested elements and report a miss as undefined", () => {
    const tree = parseHtml("<article><section><p>x</p></section></article>").root;

    expect(findElement(tree, "p")?.tag).toBe("p");
    expect(findElement(tree, "nav")).toBeUndefined();
  });

  it("should only descend into element/document nodes", () => {
    const text: HtmlNode = { kind: "text", value: "x" };

    expect(childrenOf({ kind: "comment", data: "c" })).toEqual([]);
    expect(childrenOf({ kind: "doctype", name: "html", publicId: "", systemId: "" })).toEqual([]);
    expect(childrenOf({ kind: "document", children: [text] })).toHaveLength(1);
  });

  it("should read attributes without throwing on a miss", () => {
    const div = requireElement(parseHtml('<div a="1">x</div>').root, "div");

    expect(attributeValue(div, "a")).toBe("1");
    expect(attributeValue(div, "b")).toBeUndefined();
  });
});

describe("测试工具自检 · 异常与遍历", () => {
  it("should return the thrown value, or undefined when nothing throws", () => {
    const error = new Error("boom");

    expect(
      catchThrown(() => {
        throw error;
      }),
    ).toBe(error);
    expect(catchThrown(() => undefined)).toBeUndefined();
  });

  it("should refuse to call a non-function in callWithUnknown", () => {
    expect(
      catchThrown(() => {
        callWithUnknown(42, "x");
      }),
    ).toBeInstanceOf(Error);
  });

  it("should collect every element in document order", () => {
    const tree = parseHtml("<article><p>a</p><section><p>b</p></section></article>").root;

    expect(collectElements(tree).map((node) => node.tag)).toEqual([
      "html",
      "head",
      "body",
      "article",
      "p",
      "section",
      "p",
    ]);
  });
});
