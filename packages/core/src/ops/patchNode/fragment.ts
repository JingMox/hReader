// 这层管：片段校验（先按 HTML5 容错解析成树，再校验恰好一个根元素 + 表格上下文 + 可执行内容拒绝名单）并剥掉片段自带 ID；不分配 ID、不碰 IO。

import type { Diagnostic, HtmlElementNode, HtmlNode } from "../../html/constants";
import { parseHtml } from "../../html/parse";
import { drainStack } from "../../html/stack";
import { HrError } from "../../hr-error";
import { attributeValueLoose, hasAttributeLoose } from "./attrs";
import {
  FORBIDDEN_TAGS,
  FORBIDDEN_VALUE_PREFIXES,
  SVG_CONTAINER,
  SVG_EVENT_TAGS,
} from "./constants";
import { stripHrIds } from "./ids";
import {
  assertNoAncestorClosed,
  assertNothingEscaped,
  assertTokensSurvived,
  contentNodesOf,
  isContentNode,
  scanTokens,
  shellChildren,
  singleElementOf,
} from "./fragmentTokens";
import { walkElements } from "./walk";

/**
 * 片段根是表格/下拉结构元素时，解析必须套上它的祖先链：脱离表格上下文单独解析，解析器会丢弃这些标签
 * （只剩字面文本）或把它们 foster-parent 移出表格。套上祖先链后，"`<tr>` 片段"解析回来仍是那个 `<tr>`。
 * 值 = 让片段根成为最深层容器**直接子节点**所需的开标签序列。
 */
const CONTEXT_ANCESTORS: Readonly<Record<string, readonly string[]>> = {
  colgroup: ["table"],
  col: ["table", "colgroup"],
  caption: ["table"],
  thead: ["table"],
  tbody: ["table"],
  tfoot: ["table"],
  tr: ["table", "tbody"],
  td: ["table", "tbody", "tr"],
  th: ["table", "tbody", "tr"],
  option: ["select"],
  optgroup: ["select"],
};

/** 片段里第一个根级标签名（小写）；纯文本片段没有标签，返回 undefined。 */
const FIRST_TAG = /^\s*<\s*([a-zA-Z][a-zA-Z0-9-]*)/u;

const firstTagOf = (html: string): string | undefined => FIRST_TAG.exec(html)?.[1]?.toLowerCase();

/** 把片段套进祖先链一起解析；只拼固定标签名，无用户输入。 */
const inContext = (html: string, ancestors: readonly string[]): string =>
  ancestors.map((tag) => `<${tag}>`).join("") +
  html +
  [...ancestors]
    .reverse()
    .map((tag) => `</${tag}>`)
    .join("");

const directChildTag = (node: HtmlNode, tag: string): HtmlElementNode | undefined => {
  // 调用方只传 document 或 element（见 `ancestorChainOf` 的 root 与 `throughShells` 的栈，两者都只放外壳），
  // `[]` 分支是类型收窄专用，跑不到。
  /* v8 ignore next */
  const children = node.kind === "element" || node.kind === "document" ? node.children : [];
  return children.find(
    (child): child is HtmlElementNode => child.kind === "element" && child.tag === tag,
  );
};

/**
 * 沿祖先链下钻到最深层容器元素：每层优先取直接子节点（解析器就是这么放结构元素的），
 * 只有第一层需要穿过外壳（`document`/`html`/`head`/`body`）。
 * 返回整条链（包装器逐个都在里面），`contextOf` 取链尾。
 */
const ancestorChainOf = (
  root: HtmlNode,
  ancestors: readonly string[],
): readonly HtmlElementNode[] => {
  const [first, ...rest] = ancestors;
  if (first === undefined) return [];
  const chain: HtmlElementNode[] = [];
  let node = directChildTag(root, first) ?? throughShells(root, first);
  if (node !== undefined) chain.push(node);
  for (const tag of rest) {
    // 解析器要么把整条包装链建出来，要么就建不出来：异常情况已被下面的 `throughShells` + `contextOf` 兜底。
    /* v8 ignore next */
    if (node === undefined) break;
    node = directChildTag(node, tag);
    if (node !== undefined) chain.push(node);
  }
  return chain;
};

const contextOf = (root: HtmlNode, ancestors: readonly string[]): HtmlElementNode => {
  const chain = ancestorChainOf(root, ancestors);
  const context = chain.at(-1);
  // 上下文包装链由 `inContext` 写进片段再交给解析器；解析器顶多截短（就成上位报错），不会凭空补链。
  // 因此“链不全 / 容器缺失”只能靠变异证明（比如让 `CONTEXT_ANCESTORS` 写错），正常路径跑不到。
  /* v8 ignore start */
  if (chain.length !== ancestors.length || context === undefined) {
    throw new HrError(
      "invalid_fragment",
      `片段解析后找不到上下文容器 <${ancestors.join("><")}>；请检查片段结构`,
    );
  }
  /* v8 ignore stop */
  return context;
};

/** 只在外壳层里找目标标签（`document`/`html`/`body`），不跨内容层——内容层的层级由 `contextOf` 逐层走。 */
const throughShells = (root: HtmlNode, tag: string): HtmlElementNode | undefined => {
  const stack: HtmlNode[] = [root];
  for (const node of drainStack(stack)) {
    const found = directChildTag(node, tag);
    if (found !== undefined) return found;
    // 防御兜底（只靠变异证明跑不到）：栈里只放根（document）与外壳元素，`shellChildren` 对它们必有值；
    // 而“容器没进树”这种情形走不到这里——`inContext` 已把包装标签写进片段，缺链就是 `contextOf` 的 `invalid_fragment`。
    /* v8 ignore start */
    for (const child of shellChildren(node) ?? []) stack.push(child);
  }
  return undefined;
};
/* v8 ignore stop */

const forbidden = (message: string): HrError => new HrError("forbidden_content", message);

/** URL 取值先剥空白与控制字符再小写：`java\tscript:` / `JaVaScRiPt:` 必须与 `javascript:` 同判。 */
const IGNORABLE = /[\s\p{Cc}]/gu;

/** `values` 的分隔符只认分号（SMIL 规范）：逗号/空白属于同一项，不能拿来切。 */
const LIST_SEPARATOR = ";";

const normalizedUrl = (value: string): string => value.replaceAll(IGNORABLE, "").toLowerCase();

const assertTagAllowed = (node: HtmlElementNode): void => {
  if (FORBIDDEN_TAGS.has(node.tag)) {
    throw forbidden(`片段含可执行/外部资源容器 <${node.tag}>，已拒绝`);
  }
  if (
    node.tag === "meta" &&
    (hasAttributeLoose(node.attrs, "http-equiv") || hasAttributeLoose(node.attrs, "charset"))
  ) {
    throw forbidden("片段含可改写文档行为的 <meta http-equiv|charset>，已拒绝");
  }
};

/** 危险协议的判定只此一处：属性值与 SVG 动画取值共用，避免两套口径漂移（v3#16）。 */
const forbiddenUrlOf = (raw: string): string | undefined =>
  FORBIDDEN_VALUE_PREFIXES.find((candidate) => normalizedUrl(raw).startsWith(candidate));

/**
 * 列表取值（SMIL 的 `values`、以及任何可能写成 `a;b` 的属性）必须**逐项**判：
 * 只对整串做 `startsWith` 时 `values="safe;javascript:…"` 会直接绕过。
 */
const forbiddenInList = (raw: string): string | undefined => {
  for (const candidate of raw.split(LIST_SEPARATOR)) {
    const prefix = forbiddenUrlOf(candidate);
    if (prefix !== undefined) return prefix;
  }
  return undefined;
};

const assertAttributesAllowed = (node: HtmlElementNode): void => {
  for (const [name, value] of node.attrs) {
    if (name.toLowerCase().startsWith("on")) {
      throw forbidden(`片段含事件属性 ${name}（<${node.tag}>），已拒绝`);
    }
    const prefix = forbiddenInList(value);
    if (prefix !== undefined) {
      throw forbidden(`片段含 ${prefix} 取值（<${node.tag} ${name}>），已拒绝`);
    }
  }
};

/** v3#16：动画改的是"元素级 URL 属性"时必须与直接写 `href` **同口径**（都按 `;` 逐项判），否则就是绕过面。 */
const ANIMATION_URL_TARGETS: ReadonlySet<string> = new Set(["href", "src", "xlink:href"]);

/** `values` 是 SMIL 的分号列表；`to/from/by` 是单值（单值里的分号属于相对 URL 本身，v3#17）。 */
const ANIMATION_LIST_ATTRIBUTE = "values";
const ANIMATION_SINGLE_ATTRIBUTES: readonly string[] = ["to", "from", "by"];

const forbidValue = (node: HtmlElementNode, name: string, prefix: string): never => {
  throw forbidden(`片段含 SVG <${node.tag} ${name}="${prefix}…">（可写危险 URL），已拒绝`);
};

/** SVG 动画元素能改写父节点事件属性（`attributeName="onload"`），必须按 svg 上下文单独判。 */
const assertAnimationAllowed = (node: HtmlElementNode): void => {
  if (!SVG_EVENT_TAGS.has(node.tag)) return;
  const target = normalizedUrl(attributeValueLoose(node.attrs, "attributename") ?? "");
  if (target.startsWith("on")) {
    throw forbidden(`片段含 SVG <${node.tag} attributeName="${target}">（可写事件处理器），已拒绝`);
  }
  if (!ANIMATION_URL_TARGETS.has(target)) return;
  for (const name of ANIMATION_SINGLE_ATTRIBUTES) {
    const prefix = forbiddenUrlOf(attributeValueLoose(node.attrs, name) ?? "");
    if (prefix !== undefined) forbidValue(node, name, prefix);
  }
  const values = attributeValueLoose(node.attrs, ANIMATION_LIST_ATTRIBUTE);
  const listPrefix = values === undefined ? undefined : forbiddenInList(values);
  if (listPrefix !== undefined) forbidValue(node, ANIMATION_LIST_ATTRIBUTE, listPrefix);
};

/** 只在 `<svg>` 子树里判：树外的同名标签没有改写父属性的能力，不该被误杀。 */
const assertSvgAnimations = (svg: HtmlElementNode): void => {
  walkElements(svg, assertAnimationAllowed);
};

const assertNoForbiddenContent = (root: HtmlNode): void => {
  walkElements(root, (node) => {
    assertTagAllowed(node);
    assertAttributesAllowed(node);
    if (node.tag === SVG_CONTAINER) assertSvgAnimations(node);
  });
};

/**
 * M1.1 契约：入参不合法必须是 `invalid_html`，不能漏成 TypeError。
 * `parseFragment` 在 `parseHtml` 之前还有 token 扫描，类型外的入参必须先在这里被拦住。
 */
function assertHtmlString(html: unknown): asserts html is string {
  if (typeof html !== "string") {
    throw new HrError("invalid_html", "parseFragment 只接受字符串；类型系统外的输入不可恢复");
  }
}

/** 片段结果的返回面：`warnings` 是片段自己的解析诊断（不再静默丢弃）。 */
interface FragmentResult {
  readonly root: HtmlNode;
  readonly warnings: readonly Diagnostic[];
}

/**
 * 片段根上自带的 `data-hr-id` 一律剥掉：ID 只能由注入器按整篇文档重新分配。
 * 这一版把解析诊断一并回给调用方（`applyPatch` 当 warning 上浮）；只要树的调用方用 `parseFragment`。
 */
export const parseFragmentWithDiagnostics = (html: string): FragmentResult => {
  // #13：空片段是"内容不成立"；非字符串走 M1.1 契约（invalid_html），与 parseHtml 同口径。
  assertHtmlString(html);
  if (html.trim().length === 0) {
    throw new HrError("invalid_fragment", "片段为空或只有空白：必须恰好有一个根元素");
  }
  // 先解析、后校验：可选结束标签（`<li>a<li>b` 等）由 HTML5 容错解析自动闭合，
  // 不能在解析前拿原始源码当平衡错误拒绝。表格/下拉结构片段先套上祖先链再解析，
  // 否则解析器会把它们整个丢掉；根数校验仍在解析后的树上做。
  const rootTag = firstTagOf(html);
  const ancestors = (rootTag === undefined ? undefined : CONTEXT_ANCESTORS[rootTag]) ?? [];
  // token 级自证放在解析前：`</table>` 逃逸与“解析器会丢标签”都能在解析前就拒绝。
  const tokens = scanTokens(html, ancestors);
  assertNoAncestorClosed(tokens, ancestors);
  const parsed = parseHtml(ancestors.length === 0 ? html : inContext(html, ancestors));
  assertNoForbiddenContent(parsed.root);
  assertTokensSurvived(tokens, parsed.root, ancestors);
  // 套了祖先链时，片段根是**最深层容器的子节点**，不能把容器自己算进根列表；
  // 包装链之外的节点必须先归零：那就是 foster parenting 挤出去、投影时会静默丢掉的部分。
  const chain = ancestorChainOf(parsed.root, ancestors);
  assertNothingEscaped(parsed.root, chain);
  const context = ancestors.length === 0 ? undefined : contextOf(parsed.root, ancestors);
  const candidates =
    context === undefined ? contentNodesOf(parsed.root) : context.children.filter(isContentNode);
  return { root: stripHrIds(singleElementOf(candidates)), warnings: parsed.diagnostics };
};

/** 只要片段树的调用方（对外公开面）：诊断丢不丢由调用方自己决定。 */
export const parseFragment = (html: string): HtmlNode => parseFragmentWithDiagnostics(html).root;
