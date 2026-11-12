// 这层管：容错解析 HTML 成纯数据树 + 收集诊断；不管语义校验、不碰 IO。

import { ErrorCodes, parse as parse5 } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";

import { HrError } from "../hr-error";
import { tagBalanceDiagnostics } from "./balance";
import {
  COMPONENT_ATTRIBUTE,
  COMPONENT_WHITELIST,
  type Diagnostic,
  type DiagnosticCode,
  DIAGNOSTIC_SEVERITY,
  type HtmlAttribute,
  type HtmlNode,
  META_SCRIPT_ID,
  type ParsedHtml,
} from "./constants";
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
}

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

const isString = (value: unknown): value is string => typeof value === "string";

const isElement = (node: P5Node): node is P5Element => "tagName" in node;

const isLeaf = (node: P5Node): node is P5Leaf =>
  node.nodeName === "#text" || node.nodeName === "#comment" || node.nodeName === "#documentType";

const isTemplate = (node: P5Element): node is P5Template => node.nodeName === "template";

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
  isTemplate(element) ? element.content.childNodes : element.childNodes;

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
const leafNode = (source: P5Leaf): HtmlNode => {
  if (source.nodeName === "#text") {
    return { kind: "text", value: source.value };
  }
  if (source.nodeName === "#comment") {
    return { kind: "comment", data: source.data };
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
  const attributes = toAttributes(element);
  const node: HtmlNode = { kind: "element", tag: element.tagName, attrs: attributes, children };
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
    return leafNode(source);
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

const buildTree = (document: P5Document, context: ParseContext): HtmlNode => {
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
 * 剩下的 JSON 必然解析失败，所以 JSON 可解析性就是"是否被截断"的判据（M1.2 接结构校验后替换）。
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
    // 浏览器在不跑脚本时的默认口径：`<noscript>` 内容按标记解析（实体解码），不是 raw text。
    // parse5 自己的默认是 true，会把它当 raw text 保留原始实体串，序列化时再被转义一次。
    scriptingEnabled: false,
    onParseError: (error) => {
      const code = PARSE5_TO_DIAGNOSTIC[error.code];
      if (code !== undefined) {
        context.diagnostics.push(diagnosticOf(code, `parse5 报告 ${error.code}`, undefined));
      }
    },
  });

export const parseHtml = (html: string): ParsedHtml => {
  if (!isString(html)) {
    throw new HrError("invalid_html", "parseHtml 只接受字符串；类型系统外的输入不可恢复");
  }
  const context: ParseContext = { diagnostics: [], metaScripts: [] };
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
  return { root, diagnostics: context.diagnostics };
};
