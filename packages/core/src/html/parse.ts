// 这层管：容错解析 HTML 成纯数据树 + 收集诊断；不管语义校验、不碰 IO。

import { ErrorCodes, parse as parse5, parseFragment as parse5Fragment } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";

import { HrError } from "../hr-error";
import { tagBalanceDiagnostics } from "./balance";
import { closeImplicitParagraphs } from "./implicit-close";
import {
  COMPONENT_ATTRIBUTE,
  COMPONENT_WHITELIST,
  type Diagnostic,
  type DiagnosticCode,
  DIAGNOSTIC_SEVERITY,
  type HtmlAttribute,
  type HtmlNode,
  type HtmlElementNode,
  type LeafSpan,
  META_SCRIPT_ID,
  type ParsedHtml,
  type SourceSpan,
} from "./constants";
import { ZERO_SPAN } from "./span";
import { drainStack } from "./stack";
import { textContentOf } from "./text";

type P5Node = DefaultTreeAdapterTypes.Node;
type P5Element = DefaultTreeAdapterTypes.Element;
type P5Document = DefaultTreeAdapterTypes.Document;
type P5Template = DefaultTreeAdapterTypes.Template;
type P5Leaf =
  | DefaultTreeAdapterTypes.TextNode
  | DefaultTreeAdapterTypes.CommentNode
  | DefaultTreeAdapterTypes.DocumentType;

interface ParseContext {
  readonly diagnostics: Diagnostic[];
  readonly metaScripts: HtmlNode[];
  readonly locations: boolean;
  readonly scriptingEnabled: boolean;
}

/** 元素必有 startTag；缺位置时整体退化为零宽区间。 */
type P5Location = NonNullable<P5Element["sourceCodeLocation"]>;
type P5StartTag = NonNullable<P5Location["startTag"]>;

const spanOfLocation = (location: P5Location, startTag: P5StartTag): SourceSpan => ({
  start: location.startOffset,
  end: location.endOffset,
  innerStart: startTag.endOffset,
  innerEnd: location.endTag === undefined ? location.endOffset : location.endTag.startOffset,
});

const sourceSpanOf = (element: P5Element): SourceSpan => {
  const location = element.sourceCodeLocation;
  if (!location?.startTag) {
    return ZERO_SPAN;
  }
  return spanOfLocation(location, location.startTag);
};

interface OpenTask {
  readonly source: P5Node;
  readonly sink: HtmlNode[];
  /** 父节点的定位串；空串代表文档根。 */
  readonly parentPath: string;
  /** 在父节点 childNodes 里的下标。 */
  readonly index: number;
}

/**
 * 只保留能实测触发的 parse5 错误码：parse5 的 `onParseError` 只报 tokenizer 级问题，
 * 未闭合/错嵌套这类树构造级错误它根本不报（由 balance.ts 从原文自检）。
 */
const PARSE5_TO_DIAGNOSTIC: Readonly<Partial<Record<ErrorCodes, DiagnosticCode>>> = {
  [ErrorCodes.eofBeforeTagName]: "unclosed_tag",
  [ErrorCodes.eofInTag]: "unclosed_tag",
  [ErrorCodes.eofInComment]: "unclosed_tag",
  [ErrorCodes.eofInCdata]: "unclosed_tag",
  [ErrorCodes.eofInDoctype]: "unclosed_tag",
  [ErrorCodes.eofInElementThatCanContainOnlyText]: "unclosed_tag",
  [ErrorCodes.missingEndTagName]: "unclosed_tag",
  [ErrorCodes.endTagWithAttributes]: "misnested_tag",
  [ErrorCodes.duplicateAttribute]: "duplicate_attribute",
};

/** 用户看得懂的报文；表里没有的 parse5 错误码退回原始码。 */
const PARSE5_MESSAGE: Readonly<Partial<Record<ErrorCodes, string>>> = {
  [ErrorCodes.duplicateAttribute]:
    "开始标签里有重复属性（parse5: duplicate-attribute），解析器只保留第一个，写回去会少掉后一个",
};

const isString = (value: unknown): value is string => typeof value === "string";

const isElement = (node: P5Node): node is P5Element => "tagName" in node;

const isLeaf = (node: P5Node): node is P5Leaf =>
  node.nodeName === "#text" || node.nodeName === "#comment" || node.nodeName === "#documentType";

/**
 * 只有 HTML 命名空间的 `template` 才有 `content` 片段（parse5 仅在 `_insertTemplate` 里挂，且硬编码 `NS.HTML`）；
 * foreign content（svg/math）里的 `<template>` 是普通元素，按 `nodeName` 判定会去读不存在的 `content`。
 */
const hasTemplateContent = (node: P5Element): node is P5Template => "content" in node;

const diagnosticOf = (
  code: DiagnosticCode,
  message: string,
  path: string | undefined,
): Diagnostic => {
  const severity = DIAGNOSTIC_SEVERITY[code];
  return path === undefined ? { code, severity, message } : { code, severity, message, path };
};

const attributeOf = (element: P5Element, name: string): string | undefined => {
  for (const attribute of element.attrs) {
    if (attribute.name === name) {
      return attribute.value;
    }
  }
  return undefined;
};

const joinPath = (parentPath: string, segment: string): string =>
  parentPath.length === 0 ? segment : `${parentPath}>${segment}`;

/** `template` 的子节点挂在 `content` 上而不是 `childNodes`，漏了会在往返时丢掉整棵子树。 */
const descendantsOf = (element: P5Element): readonly P5Node[] =>
  hasTemplateContent(element) ? element.content.childNodes : element.childNodes;

const componentDiagnostic = (element: P5Element, context: ParseContext, path: string): void => {
  const value = attributeOf(element, COMPONENT_ATTRIBUTE);
  if (value === undefined || COMPONENT_WHITELIST.includes(value)) {
    return;
  }
  context.diagnostics.push(
    diagnosticOf(
      "invalid_component",
      `<${element.tagName} ${COMPONENT_ATTRIBUTE}="${value}"> 不在白名单内，属性保留待人工修复`,
      path,
    ),
  );
};

/** 只处理叶子：元素先建骨再由调用方填子，深文档下也不会递归爆栈。 */
const leafNode = (source: P5Leaf, context: ParseContext): HtmlNode => {
  const location = context.locations ? source.sourceCodeLocation : undefined;
  const span: LeafSpan | undefined =
    location?.startOffset === undefined
      ? undefined
      : { start: location.startOffset, end: location.endOffset };
  if (source.nodeName === "#text") {
    return span === undefined
      ? { kind: "text", value: source.value }
      : { kind: "text", value: source.value, span };
  }
  if (source.nodeName === "#comment") {
    return span === undefined
      ? { kind: "comment", data: source.data }
      : { kind: "comment", data: source.data, span };
  }
  return {
    kind: "doctype",
    name: source.name,
    publicId: source.publicId,
    systemId: source.systemId,
  };
};

const toAttributes = (element: P5Element): readonly HtmlAttribute[] =>
  element.attrs.map((attribute) => [attribute.name, attribute.value] as const);

const createElementNode = (
  element: P5Element,
  children: HtmlNode[],
  context: ParseContext,
  path: string,
): HtmlNode => {
  componentDiagnostic(element, context, path);
  const base: HtmlElementNode = {
    kind: "element",
    tag: element.tagName,
    attrs: toAttributes(element),
    children,
  };
  const node: HtmlNode = context.locations ? { ...base, span: sourceSpanOf(element) } : base;
  const id = attributeOf(element, "id");
  if (element.tagName === "script" && id === META_SCRIPT_ID) {
    context.metaScripts.push(node);
  }
  return node;
};

const pushChildTasks = (
  children: readonly P5Node[],
  sink: HtmlNode[],
  stack: OpenTask[],
  parentPath: string,
): void => {
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    if (child !== undefined) {
      stack.push({ source: child, sink, parentPath, index });
    }
  }
};

const openSource = (task: OpenTask, context: ParseContext, stack: OpenTask[]): HtmlNode => {
  const { source, parentPath, index } = task;
  if (isLeaf(source)) {
    return leafNode(source, context);
  }
  if (isElement(source)) {
    const path = joinPath(parentPath, `${source.tagName}[${String(index)}]`);
    const children: HtmlNode[] = [];
    const node = createElementNode(source, children, context, path);
    pushChildTasks(descendantsOf(source), children, stack, path);
    return node;
  }
  const children: HtmlNode[] = [];
  pushChildTasks(source.childNodes, children, stack, parentPath);
  return { kind: "document", children };
};

const buildTree = (
  document: P5Document | DefaultTreeAdapterTypes.DocumentFragment,
  context: ParseContext,
): HtmlNode => {
  const stack: OpenTask[] = [];
  const root = openSource(
    { source: document, sink: [], parentPath: "", index: -1 },
    context,
    stack,
  );
  for (const task of drainStack(stack)) {
    task.sink.push(openSource(task, context, stack));
  }
  return root;
};

/**
 * meta 契约是"浏览器端可 JSON.parse"。原文里写了 `</script>` 会提前结束 raw text，
 * 剩下的 JSON 必然解析失败，所以 JSON 可解析性就是"是否被截断"的判据。
 */
const metaScriptDiagnostics = (context: ParseContext): void => {
  for (const script of context.metaScripts) {
    const text = textContentOf(script).trim();
    if (text.length === 0) {
      continue;
    }
    try {
      JSON.parse(text);
    } catch {
      context.diagnostics.push(
        diagnosticOf(
          "script_in_meta",
          `<script id="${META_SCRIPT_ID}"> 内容不是完整 JSON，多半被正文里的 </script> 提前截断`,
          "script#hr-meta",
        ),
      );
    }
  }
};

const parseWithErrorDiagnostics = (html: string, context: ParseContext): P5Document =>
  parse5(html, {
    sourceCodeLocationInfo: context.locations,
    // 浏览器在不跑脚本时的默认口径：`<noscript>` 内容按标记解析（实体解码），不是 raw text。
    // parse5 自己的默认是 true，会把它当 raw text 保留原始实体串，序列化时再被转义一次。
    // The annotation body-text domain (relocate) needs true instead: that tree always
    // runs in a scripting-enabled browser, where `<noscript>` ends at the first
    // `</noscript>`, and both sides must agree on the visible text.
    scriptingEnabled: context.scriptingEnabled,
    onParseError: (error) => {
      const code = PARSE5_TO_DIAGNOSTIC[error.code];
      if (code !== undefined) {
        context.diagnostics.push(
          diagnosticOf(code, PARSE5_MESSAGE[error.code] ?? `parse5 报告 ${error.code}`, undefined),
        );
      }
    },
  });

/** `locations` is enabled only when writing back by source range; off by default, and
 *  turning it off leaves the tree and diagnostics unchanged. `scriptingEnabled` is
 *  enabled only for the annotation body-text domain (relocate): that tree always runs
 *  in a scripting-enabled browser (`<noscript>` is cut as raw text); every other path
 *  keeps the no-scripting view. */
export const parseHtml = (
  html: string,
  options: { readonly locations?: boolean; readonly scriptingEnabled?: boolean } = {},
): ParsedHtml => {
  if (!isString(html)) {
    throw new HrError("invalid_html", "parseHtml 只接受字符串；类型系统外的输入不可恢复");
  }
  const context: ParseContext = {
    diagnostics: [],
    metaScripts: [],
    locations: options.locations === true,
    scriptingEnabled: options.scriptingEnabled === true,
  };
  if (html.trim().length === 0) {
    context.diagnostics.push(
      diagnosticOf("empty_document", "文档为空，没有可解析的内容", undefined),
    );
    return { root: { kind: "document", children: [] }, diagnostics: context.diagnostics };
  }
  const document = parseWithErrorDiagnostics(html, context);
  context.diagnostics.push(...tagBalanceDiagnostics(html));
  const root = buildTree(document, context);
  metaScriptDiagnostics(context);
  // 解析器的 quirks 文档会把 `<table>` 留在 `<p>` 里（HTML5 只在 no-quirks 下补隐式结束）：树建完再统一补。
  return closeImplicitParagraphs({ root, diagnostics: context.diagnostics });
};

/**
 * The tree the bytes actually build: raw parse5 output with NO hReader
 * normalization — no `closeImplicitParagraphs`, no `buildTree` projection, no
 * diagnostics, no meta collection. The patch oracles judge this tree (a
 * normalized model verifies a DOM the bytes never produce, and a projected one
 * drops namespace), and locations are always on so a listed block maps by its
 * source extent. `scriptingEnabled` must be the caller's chosen mode —
 * `<noscript>` content differs between the two real DOMs.
 */
export const parseRawHtml = (html: string, scriptingEnabled: boolean): P5Document =>
  parse5(html, { sourceCodeLocationInfo: true, scriptingEnabled });

/**
 * The fragment source's top-level nodes on a raw parse — same contract as
 * `parseRawHtml`. The block-patch post-write oracle splices these at the block's
 * raw slot: this is the DOM parse5 builds for the fragment in place.
 */
export const parseRawFragmentNodes = (html: string, scriptingEnabled: boolean): readonly P5Node[] =>
  parse5Fragment(html, { sourceCodeLocationInfo: true, scriptingEnabled }).childNodes;
