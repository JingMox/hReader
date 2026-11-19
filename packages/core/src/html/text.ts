// 这层管：把一棵子树的文本按文档序收集到上限为止（meta 校验要全文，ID 种子只要前缀）。

import type { HtmlNode } from "./constants";

const childNodesOf = (node: HtmlNode): readonly HtmlNode[] => {
  if (node.kind === "element" || node.kind === "document") {
    return node.children;
  }
  return [];
};

/**
 * 全树一次性求"每个节点的文本前缀"（后序迭代，不用递归：40k 层文档不能爆栈）。
 *
 * 单独调 `textSampleOf` 是 O(子树到首个文本的深度)：深嵌套文档里每个祖先都要下沉到底才能取到 1 个字符，
 * 逐个调用退化成 O(n²)。后序一次算完是 O(n·limit)：节点前缀 = 子节点前缀依次拼到 `limit` 为止，
 * 与"先序遍历取前 limit 个字符"逐字节相同（注释/doctype 不产生文本，与 `textSampleOf` 同口径）。
 */
/** 逆序压入子节点：栈是后进先出，逆序压才能按文档序出栈。 */
const pushUnvisited = (
  children: readonly HtmlNode[],
  pending: { readonly node: HtmlNode; readonly childrenDone: boolean }[],
): void => {
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    if (child !== undefined) pending.push({ node: child, childrenDone: false });
  }
};

export const textSamplesOf = (root: HtmlNode, limit: number): Map<HtmlNode, string> => {
  const samples = new Map<HtmlNode, string>();
  const pending: { readonly node: HtmlNode; readonly childrenDone: boolean }[] = [
    { node: root, childrenDone: false },
  ];
  while (pending.length > 0) {
    const frame = pending.pop();
    // 循环条件已保证非空；`pop` 的 `undefined` 只是 `Array#pop` 的签名，这条分支跑不到。
    /* v8 ignore next */
    if (frame === undefined) break;
    const children = childNodesOf(frame.node);
    if (!frame.childrenDone) {
      pending.push({ node: frame.node, childrenDone: true });
      pushUnvisited(children, pending);
      continue;
    }
    samples.set(frame.node, sampleFromChildren(frame.node, children, samples, limit));
  }
  return samples;
};

/** 单节点前缀：文本节点截断，容器拼子节点前缀直到够长，注释/doctype 无文本。 */
const sampleFromChildren = (
  node: HtmlNode,
  children: readonly HtmlNode[],
  samples: ReadonlyMap<HtmlNode, string>,
  limit: number,
): string => {
  if (node.kind === "text") return node.value.slice(0, limit);
  let acc = "";
  for (const child of children) {
    // 后序遍历保证每个子节点在轮到父节点时都已写进 `samples`；`?? ""` 只是 `Map#get` 的签名，跑不到。
    /* v8 ignore next */
    acc += samples.get(child) ?? "";
    if (acc.length >= limit) break;
  }
  return acc.slice(0, limit);
};

/**
 * 收集文本前缀——就是 `textSamplesOf` 的整树后序一次算满（逐个节点下沉求和在大文档上是 O(n²)）。
 * `limit` 传 `Infinity` 即全文（meta 校验的口径）。
 */
const textSampleOf = (node: HtmlNode, limit: number): string => {
  // `textSamplesOf` 会给根帧自己也写一条，因此 `get(node)` 必有值；`?? ""` 只是 `Map#get` 的签名。
  /* v8 ignore next */
  return textSamplesOf(node, limit).get(node) ?? "";
};

export const textContentOf = (node: HtmlNode): string =>
  textSampleOf(node, Number.POSITIVE_INFINITY);

/** 空白归一：连续空白（含换行/制表/全角空格/NBSP）压成单空格，首尾 trim。 */
export const normalizeWhitespace = (text: string): string => text.replace(/\s+/gu, " ").trim();
