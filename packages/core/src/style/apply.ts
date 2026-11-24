// 这层管：只改 `<style id="hr-theme">` 的区间（源码区间拼接，块外字节原样）；不碰 IO。

import { type HtmlElementNode, type HtmlNode, type SourceSpan } from "../html/constants";
import { parseHtml } from "../html/parse";
import { ZERO_SPAN } from "../html/span";
import { drainStack } from "../html/stack";
import { HrError } from "../hr-error";
import { assertThemeSafe } from "./css";

/** 与 `ops/read-node/constants.ts` 的 `THEME_ANCHOR_ID` 同值：外壳锚点是 docs/02 §3.1 的规范常量。 */
const THEME_ANCHOR_ID = "hr-theme";

/** 没有 `<html>` 时唯一的落点：紧跟 prologue（doctype/注释/缩进），绝不插到它前面。 */
const PROLOGUE = /^(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/iu;

export interface ReplaceThemeResult {
  readonly html: string;
  readonly changed: boolean;
  /** 被删掉的重复主题块数量：锚点始终收敛到一个（G2 P1-2）。 */
  readonly removed: number;
}

interface Splice {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

interface Anchor {
  readonly node: HtmlElementNode;
  readonly span: SourceSpan;
}

/** `locations: true` 下每个元素都有区间；`{ ...ZERO_SPAN, ...undefined }` 仍是零宽，无需分支。 */
/** 与 `html/span.ts` 的 `spanOf` 不同：这里只取值——缺失（未开 locations）就补零宽，不回答"元素在不在"（P2-2）。 */
const spanOrZero = (node: HtmlElementNode): SourceSpan => ({ ...ZERO_SPAN, ...node.span });

/** 源码里真的有字节：parse5 合成的 `<html>`/`<head>` 拿到零宽区间，与"源码里没有该标签"同义。 */
const hasBytes = (span: SourceSpan): boolean => span.end > span.start;

const attributeOf = (node: HtmlElementNode, wanted: string): string | undefined => {
  for (const [name, value] of node.attrs) {
    if (name === wanted) return value;
  }
  return undefined;
};

/** 锚点 `id` 大小写不敏感（`id="HR-THEME"` 还是同一个锚点，G2 P2-4）。 */
const isThemeBlock = (node: HtmlElementNode): boolean =>
  node.tag === "style" && attributeOf(node, "id")?.toLowerCase() === THEME_ANCHOR_ID;

/** 非规范拼写（大写/带额外属性）整块重写成规范形态，重写后即可幂等。 */
const isCanonicalAnchor = (node: HtmlElementNode): boolean =>
  attributeOf(node, "id") === THEME_ANCHOR_ID;

/** 文档序（先序）找元素：前序 push 子节点时倒序入栈，弹出顺序才是源码顺序。 */
const pushReversed = (children: readonly HtmlNode[], stack: HtmlNode[]): void => {
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    if (child !== undefined) stack.push(child);
  }
};

const themesOf = (root: HtmlNode): readonly Anchor[] => {
  const stack: HtmlNode[] = [root];
  const anchors: Anchor[] = [];
  for (const node of drainStack(stack)) {
    if (node.kind === "element") {
      if (isThemeBlock(node)) anchors.push({ node, span: spanOrZero(node) });
      pushReversed(node.children, stack);
      continue;
    }
    if (node.kind === "document") pushReversed(node.children, stack);
  }
  return anchors;
};

/** 首个出现位置（每个标签一份）：合成的 `<head>` 与"根本没有 head"都由零宽区间区分。 */
const tagSpansOf = (root: HtmlNode): ReadonlyMap<string, SourceSpan> => {
  const spans = new Map<string, SourceSpan>();
  const stack: HtmlNode[] = [root];
  for (const node of drainStack(stack)) {
    if (node.kind === "element") {
      if (!spans.has(node.tag)) spans.set(node.tag, spanOrZero(node));
      pushReversed(node.children, stack);
      continue;
    }
    if (node.kind === "document") pushReversed(node.children, stack);
  }
  return spans;
};

const tagSpanOf = (spans: ReadonlyMap<string, SourceSpan>, tag: string): SourceSpan => ({
  ...ZERO_SPAN,
  ...spans.get(tag),
});

const styleBlock = (css: string): string => `<style id="${THEME_ANCHOR_ID}">${css}</style>`;

const splice = (start: number, end: number, text: string): Splice => ({ start, end, text });

const prologueEnd = (html: string): number => PROLOGUE.exec(html)?.[0].length ?? 0;

/** 替换首个锚点、整块删掉其余：留着旧块就等于让 CSS 级联里的后者赢（G2 P1-2）。 */
const rewriteSplices = (
  anchors: readonly Anchor[],
  chosen: Anchor,
  css: string,
): readonly Splice[] => {
  const replacement = isCanonicalAnchor(chosen.node)
    ? splice(chosen.span.innerStart, chosen.span.innerEnd, css)
    : splice(chosen.span.start, chosen.span.end, styleBlock(css));
  const deletions = anchors
    .filter((anchor) => anchor !== chosen)
    .map((anchor) => splice(anchor.span.start, anchor.span.end, ""));
  return [replacement, ...deletions];
};

/**
 * 没有锚点时的注入点：真实 `<head>` 走它的末尾；合成的 `<head>` 没有源码位置，
 * 就新建一个插在 `<html>` 开标签之后（无 `<html>` 时插在 doctype 之后）——否则会把
 * `<!doctype html>` 挤出字节 0，浏览器转进 quirks mode（G2 P0-1）。
 */
const insertSplices = (html: string, root: HtmlNode, css: string): readonly Splice[] => {
  const spans = tagSpansOf(root);
  if (!spans.has("head")) {
    throw new HrError(
      "invalid_html",
      "文档没有 <head>：无从注入主题样式块（AC7.4 要求注入 head 末尾）",
    );
  }
  const head = tagSpanOf(spans, "head");
  if (hasBytes(head)) return [splice(head.innerEnd, head.innerEnd, styleBlock(css))];
  const htmlSpan = tagSpanOf(spans, "html");
  const at = hasBytes(htmlSpan) ? htmlSpan.innerStart : prologueEnd(html);
  return [splice(at, at, `<head>${styleBlock(css)}</head>`)];
};

/** 从后往前拼：所有偏移都取自同一份原文，倒序应用才不会互相错位。 */
const spliceAll = (html: string, splices: readonly Splice[]): string => {
  const ordered = [...splices].sort((left, right) => right.start - left.start);
  return ordered.reduce(
    (acc, one) => `${acc.slice(0, one.start)}${one.text}${acc.slice(one.end)}`,
    html,
  );
};

const removedOf = (anchors: readonly Anchor[], chosen: Anchor | undefined): number =>
  anchors.filter((anchor) => anchor !== chosen && hasBytes(anchor.span)).length;

/** 幂等：同 CSS 再应用一次返回 `changed: false` 且 `html` 与入参逐字节相同。 */
export const replaceTheme = (html: string, css: string): ReplaceThemeResult => {
  assertThemeSafe(css);
  const parsed = parseHtml(html, { locations: true });
  const anchors = themesOf(parsed.root);
  const chosen = anchors.find((anchor) => hasBytes(anchor.span));
  const splices =
    chosen === undefined
      ? insertSplices(html, parsed.root, css)
      : rewriteSplices(anchors, chosen, css);
  const patched = spliceAll(html, splices);
  return { html: patched, changed: patched !== html, removed: removedOf(anchors, chosen) };
};
