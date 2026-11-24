// 这层管：测试共用的小工具（树遍历、运行期类型擦除调用）+ 工具自身的自检。
// 为什么只能叫 `*.test.ts`：knip.json 的 entry 只认 `packages/*/src/index.ts`，`project` 里的
// `packages/*/tests/**/*.ts` 若无测试用例就会被 `knip --strict` 报 "Unused files"（实测改名
// `html-support.ts` 即红，而 knip.json 不在测试员白名单，改不了）。。
// 因此自检必须留在本文件内（独立 guard 文件会把 6 条重复注册进每个 import 方）。

import { describe, expect, it } from "vitest";

import { parseHtml } from "../src/index";
import type { HtmlElementNode, HtmlNode, ParsedHtml } from "../src/index";

export const codesOf = (parsed: ParsedHtml): readonly string[] =>
  parsed.diagnostics.map((diagnostic) => diagnostic.code);

export const messagesOf = (parsed: ParsedHtml): readonly string[] =>
  parsed.diagnostics.map((diagnostic) => diagnostic.message);

/** 只有 element/document 有子节点；其余节点返回空表，省掉调用方的分支。 */
export const childrenOf = (node: HtmlNode): readonly HtmlNode[] =>
  node.kind === "element" || node.kind === "document" ? node.children : [];

const pushChildrenReversed = (stack: HtmlNode[], children: readonly HtmlNode[]): void => {
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    if (child !== undefined) {
      stack.push(child);
    }
  }
};

/** 迭代 DFS：找第一个 tag 匹配的元素（深树用递归会爆栈，这里不冒这个险）。 */
export const findElement = (node: HtmlNode, tag: string): HtmlElementNode | undefined => {
  const stack: HtmlNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      break;
    }
    if (current.kind === "element" && current.tag === tag) {
      return current;
    }
    pushChildrenReversed(stack, childrenOf(current));
  }
  return undefined;
};

export const collectElements = (node: HtmlNode): readonly HtmlElementNode[] => {
  const found: HtmlElementNode[] = [];
  const stack: HtmlNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      break;
    }
    if (current.kind === "element") {
      found.push(current);
    }
    pushChildrenReversed(stack, childrenOf(current));
  }
  return found;
};

export const requireElement = (node: HtmlNode, tag: string): HtmlElementNode => {
  const found = findElement(node, tag);
  if (found === undefined) {
    throw new Error(`expected <${tag}> in tree`);
  }
  return found;
};

export const attributeValue = (node: HtmlElementNode, name: string): string | undefined =>
  node.attrs.find(([key]) => key === name)?.[1];

/**
 * 以 JS 调用方的身份调用一个函数（绕开 TS 的 string 形参）：`parseHtml` 的 `invalid_html`
 * 分支只可能被类型系统之外的调用触发，而本仓库禁止 `as` / `any` / 类型抑制注释，
 * 所以走 `Function` 类型擦除这条路，断言的是运行期契约本身。
 */
export const callWithUnknown = (fn: unknown, input: unknown): void => {
  if (typeof fn !== "function") {
    throw new Error("expected a function");
  }
  Reflect.apply(fn, undefined, [input]);
};

export const catchThrown = (action: () => void): unknown => {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
};

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
