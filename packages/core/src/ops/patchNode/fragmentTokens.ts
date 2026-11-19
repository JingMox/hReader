// 这层管：片段的 token 级自证与根级内容节点判定（tokenizer 计数、包装祖先逃逸、根列表）；不做建树、不碰 IO。

import { Tokenizer } from "parse5";
import type { TokenHandler } from "parse5";

import type { HtmlElementNode, HtmlNode } from "../../html/constants";
import { drainStack } from "../../html/stack";
import { HrError } from "../../hr-error";

const SHELL_TAGS: ReadonlySet<string> = new Set(["html", "head", "body"]);

export const isContentNode = (node: HtmlNode): boolean => {
  if (node.kind === "element" || node.kind === "comment") return true;
  return node.kind === "text" && node.value.trim().length > 0;
};

/** 外壳层（document → html → head/body）可以反复出现：非外壳节点即候选根，其余继续下钻。 */
export const shellChildren = (node: HtmlNode): readonly HtmlNode[] | undefined => {
  if (node.kind === "document") return node.children;
  if (node.kind === "element" && SHELL_TAGS.has(node.tag)) return node.children;
  return undefined;
};

export const contentNodesOf = (root: HtmlNode): readonly HtmlNode[] => {
  const candidates: HtmlNode[] = [];
  const stack: HtmlNode[] = [root];
  for (const node of drainStack(stack)) {
    const children = shellChildren(node);
    if (children !== undefined) {
      for (const child of children) stack.push(child);
      continue;
    }
    if (isContentNode(node)) candidates.push(node);
  }
  return candidates;
};

export const singleElementOf = (candidates: readonly HtmlNode[]): HtmlElementNode => {
  const [only] = candidates;
  if (candidates.length === 1 && only?.kind === "element") return only;
  throw new HrError(
    "invalid_fragment",
    `片段必须恰好有一个根元素（实际 ${String(candidates.length)} 个根级内容节点）`,
  );
};

/** 报文里把标签名去重后排成 `<a>/<b>`，用户才看得出是哪几个元素被丢了。 */
const tagListOf = (tags: readonly string[]): string =>
  [...new Set(tags)].map((tag) => (tag === "文本" ? tag : `<${tag}>`)).join("/");

/**
 * tokenizer 会把 raw-text/RCDATA 容器里的内容当字面文本，不产生子 token：
 * 计数时按标签名整段跳过，否则 `<textarea><b>x</b></textarea>` 会被误判成“丢了 `<b>`”。
 * 名单与 parse5 的 `_switchToTextParsing` / `TokenizerMode` 调用点一一对应。
 */
const TEXT_ONLY_TAGS: ReadonlySet<string> = new Set([
  "iframe",
  "noembed",
  "noframes",
  "plaintext",
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
]);

/** 解析器会自行补出来的元素：`<table><tr>` 补 `<tbody>`、`<table><col>` 补 `<colgroup>`，片段里并没有这些 token。 */
const IMPLIED_ELEMENTS: ReadonlySet<string> = new Set([
  "body",
  "colgroup",
  "head",
  "html",
  "tbody",
]);

export interface FragmentTokens {
  readonly startTags: readonly string[];
  /** 片段里闭合了包装祖先的结束标签（如 `<tbody>` 目标下的 `</table>`）；没有则为 undefined。 */
  readonly closedAncestor: string | undefined;
}

/** tokenizer 回调之间要共享的计数状态：抽成对象，避免每个回调各自长出一堆分支。 */
interface Scanning {
  readonly ancestors: readonly string[];
  readonly startTags: string[];
  readonly openAncestors: Map<string, number>;
  textOnly: string | undefined;
  closedAncestor: string | undefined;
}

const noteStartTag = (scan: Scanning, tagName: string): void => {
  if (scan.textOnly !== undefined) return;
  scan.startTags.push(tagName);
  if (TEXT_ONLY_TAGS.has(tagName)) {
    scan.textOnly = tagName;
    return;
  }
  if (!scan.ancestors.includes(tagName)) return;
  scan.openAncestors.set(tagName, (scan.openAncestors.get(tagName) ?? 0) + 1);
};

const noteEndTag = (scan: Scanning, tagName: string): void => {
  if (scan.textOnly !== undefined) {
    if (tagName === scan.textOnly) scan.textOnly = undefined;
    return;
  }
  if (!scan.ancestors.includes(tagName)) return;
  const depth = scan.openAncestors.get(tagName) ?? 0;
  if (depth === 0) {
    scan.closedAncestor ??= tagName;
    return;
  }
  scan.openAncestors.set(tagName, depth - 1);
};

const noop = (): void => undefined;

const handlerOf = (scan: Scanning): TokenHandler => ({
  onStartTag: (token) => {
    noteStartTag(scan, token.tagName);
  },
  onEndTag: (token) => {
    noteEndTag(scan, token.tagName);
  },
  onComment: noop,
  onDoctype: noop,
  onEof: noop,
  onCharacter: noop,
  onNullCharacter: noop,
  onWhitespaceCharacter: noop,
});

/**
 * 用 parse5 的 `Tokenizer`（与建树共用一个实现）走原始片段：只数 `startTag` 与包装祖先的闭合深度。
 * 不手写扫描器：手写的扫描器和被扫描的解析器会一起错。
 */
export const scanTokens = (html: string, ancestors: readonly string[]): FragmentTokens => {
  const scan: Scanning = {
    ancestors,
    startTags: [],
    openAncestors: new Map(),
    textOnly: undefined,
    closedAncestor: undefined,
  };
  new Tokenizer({}, handlerOf(scan)).write(html, true);
  return { startTags: scan.startTags, closedAncestor: scan.closedAncestor };
};

/** `</table>` 之类把包装祖先关掉的结束标签：后面写的内容会被挤到包装器之外、投影时看不见。 */
export const assertNoAncestorClosed = (
  tokens: FragmentTokens,
  ancestors: readonly string[],
): void => {
  if (tokens.closedAncestor === undefined) return;
  const closed = tokens.closedAncestor;
  const wrapper = ancestors.map((tag) => `<${tag}>`).join("");
  // 关掉外层 `<table>` 同时也把更深的包装祖先（`tbody`）一起关掉，报文得把两边都点名。
  const inner = ancestors
    .filter((tag) => tag !== closed)
    .map((tag) => `<${tag}>`)
    .join("");
  const note = inner.length === 0 ? "" : `，连带包装祖先 ${wrapper} 里的 ${inner}`;
  throw new HrError(
    "invalid_input",
    `片段闭合了外层的 <${closed}>${note}：` +
      "片段里出现它的结束标签，后面写的内容会被挤到包装器之外、静默丢失；" +
      `请去掉 </${closed}>，把要插入的内容放进片段根元素`,
  );
};

/** 解析出的元素按标签名计数（`walkElements` 会带上探针，但这里只数标签）。 */
const tagCountsOf = (root: HtmlNode): Map<string, number> => {
  const counts = new Map<string, number>();
  const stack: HtmlNode[] = [root];
  for (const node of drainStack(stack)) {
    if (node.kind !== "element" && node.kind !== "document") continue;
    if (node.kind === "element") counts.set(node.tag, (counts.get(node.tag) ?? 0) + 1);
    for (const child of node.children) stack.push(child);
  }
  return counts;
};

/**
 * token 级自证：解析后的元素必须接得住 tokenizer 数出来的起始标签。
 * 解析器在 `select`/`template`/表格上下文里会**整类忽略**起始标签（`<select><div>`、`<td><tr>`），
 * 那些内容写出去就没了，而“解析后恰好一个根”根本看不出来。
 * 不算包装祖先（不在片段 token 里）与解析器补出来的隐含元素（`html/head/body/tbody/colgroup`）。
 */
export const assertTokensSurvived = (
  tokens: FragmentTokens,
  root: HtmlNode,
  ancestors: readonly string[],
): void => {
  const present = tagCountsOf(root);
  for (const ancestor of ancestors) {
    present.set(ancestor, (present.get(ancestor) ?? 0) - 1);
  }
  const dropped: string[] = [];
  for (const tag of tokens.startTags) {
    const count = present.get(tag) ?? 0;
    if (count > 0) {
      present.set(tag, count - 1);
      continue;
    }
    if (!IMPLIED_ELEMENTS.has(tag)) dropped.push(tag);
  }
  if (dropped.length === 0) return;
  throw new HrError(
    "invalid_input",
    `片段里有 ${String(dropped.length)} 个元素在解析时被丢弃（${tagListOf(dropped)}）：` +
      "常见于 <select>/<template>/表格上下文，解析器按内容模型直接忽略这些起始标签；" +
      "写出去的字节里不会包含它们，请改写片段或换一个能容纳这些元素的容器",
  );
};

/** 根到目标的路径（含目标）：判断"哪些节点是包装器"必须看全局，不能只看片段投影。 */
const pathToNode = (root: HtmlNode, target: HtmlNode): readonly HtmlNode[] | undefined => {
  if (root === target) return [root];
  if (root.kind !== "element" && root.kind !== "document") return undefined;
  for (const child of root.children) {
    const path = pathToNode(child, target);
    if (path !== undefined) return [root, ...path];
  }
  return undefined;
};

/** 不在包装容器里、不是解析器外壳（`html`/`body`）、却又是片段内容的节点：就是被挤出去的那批。 */
const isStray = (node: HtmlNode, inside: boolean, wrappers: ReadonlySet<HtmlNode>): boolean => {
  if (inside || wrappers.has(node)) return false;
  const shell = node.kind === "element" && SHELL_TAGS.has(node.tag);
  return !shell && isContentNode(node);
};

/** 包装容器之外、又属于"片段内容"的节点：foster parenting / 静默重排的产物。 */
const straysOf = (
  root: HtmlNode,
  context: HtmlNode,
  wrappers: ReadonlySet<HtmlNode>,
): readonly HtmlNode[] => {
  const strays: HtmlNode[] = [];
  const stack: { readonly node: HtmlNode; readonly inside: boolean }[] = [
    { node: root, inside: false },
  ];
  for (const item of drainStack(stack)) {
    const inside = item.inside || item.node === context;
    if (isStray(item.node, inside, wrappers)) strays.push(item.node);
    if (item.node.kind !== "element" && item.node.kind !== "document") continue;
    for (const child of item.node.children) stack.push({ node: child, inside });
  }
  return strays;
};

/**
 * 包装器之外的内容：foster parenting 会把 `<td>` 里的 `<p>`/文本挪到 `<table>` 之前，
 * 而根列表只取最深层容器的子节点⇒那部分会被静默丢掉。
 * 只把"容器自身 + 它的祖先"（`html`/`body` 外壳、包装链）算作包装器，其余内容节点就是逃出去的。
 */
export const assertNothingEscaped = (root: HtmlNode, chain: readonly HtmlElementNode[]): void => {
  const context = chain.at(-1);
  if (context === undefined) return;
  const wrappers = new Set<HtmlNode>([...(pathToNode(root, context) ?? []), ...chain]);
  const strays = straysOf(root, context, wrappers);
  if (strays.length === 0) return;
  const labels = tagListOf(strays.map((node) => (node.kind === "element" ? node.tag : "文本")));
  throw new HrError(
    "invalid_input",
    `片段里有 ${String(strays.length)} 个节点被解析器移到了包装容器之外（${labels}）：` +
      "写出去解析回来不在包装器的同一位置，投影时会被静默丢掉；" +
      "片段请只包含要插入的那一个根元素，不要把内容放到表格/下拉结构之外",
  );
};
