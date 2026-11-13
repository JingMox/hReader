// 这层管：片段校验（恰好一个根元素 + 可执行内容拒绝名单）并剥掉片段自带 ID；不分配 ID、不碰 IO。

import type { Diagnostic, DiagnosticCode, HtmlElementNode, HtmlNode } from "../../html/constants";
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
import { walkElements } from "./walk";

const BALANCE_CODES: ReadonlySet<DiagnosticCode> = new Set(["unclosed_tag", "misnested_tag"]);

const SHELL_TAGS: ReadonlySet<string> = new Set(["html", "head", "body"]);

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

const assertBalanced = (diagnostics: readonly Diagnostic[]): void => {
  const unbalanced = diagnostics.find((diagnostic) => BALANCE_CODES.has(diagnostic.code));
  if (unbalanced !== undefined) {
    throw new HrError("invalid_fragment", `片段结构不完整：${unbalanced.message}`);
  }
};

const isContentNode = (node: HtmlNode): boolean => {
  if (node.kind === "element" || node.kind === "comment") return true;
  return node.kind === "text" && node.value.trim().length > 0;
};

/** 外壳层（document → html → head/body）可以反复出现：非外壳节点即候选根，其余继续下钻。 */
const shellChildren = (node: HtmlNode): readonly HtmlNode[] | undefined => {
  if (node.kind === "document") return node.children;
  if (node.kind === "element" && SHELL_TAGS.has(node.tag)) return node.children;
  return undefined;
};

const contentNodesOf = (root: HtmlNode): readonly HtmlNode[] => {
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

const singleElementOf = (candidates: readonly HtmlNode[]): HtmlElementNode => {
  const [only] = candidates;
  if (candidates.length === 1 && only?.kind === "element") return only;
  throw new HrError(
    "invalid_fragment",
    `片段必须恰好有一个根元素（实际 ${String(candidates.length)} 个根级内容节点）`,
  );
};

/** 片段根上自带的 `data-hr-id` 一律剥掉：ID 只能由注入器按整篇文档重新分配。 */
export const parseFragment = (html: string): HtmlNode => {
  // #13：空片段是"内容不成立"；非字符串仍走 parseHtml 的 M1.1 契约（invalid_html）。
  if (typeof html === "string" && html.trim().length === 0) {
    throw new HrError("invalid_fragment", "片段为空或只有空白：必须恰好有一个根元素");
  }
  const parsed = parseHtml(html);
  assertNoForbiddenContent(parsed.root);
  assertBalanced(parsed.diagnostics);
  return stripHrIds(singleElementOf(contentNodesOf(parsed.root)));
};
