// 测试共用的 HTML 小工具：树遍历、按标签取元素、运行期类型擦除调用。

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
