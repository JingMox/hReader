// 这层管：本层的词表与数据模型（元素/组件/属性/诊断码 + HTML 树与诊断类型）；不含逻辑。
// 类型与常量放同一文件：v8 对纯类型模块记 0% 覆盖，perFile 100% 门禁下单独的类型文件永远不可达。

/**
 * `docs/02-architecture-and-roadmap.md` 的 6 大组件列举出 7 个 `data-hr-component` 取值
 * （第 2 条 `callout-insight / warning` 是两个值）。白名单按取值计 7 个，冲突见 impl-M1.1.md。
 */
export const COMPONENT_WHITELIST: readonly string[] = [
  "kpi-bento",
  "callout-insight",
  "callout-warning",
  "split-compare",
  "deep-dive",
  "step-timeline",
  "diagram-stage",
];

/** 注入范围：`<article>` 内的块级元素；`div` 只在带 `data-hr-component` 时算块级。 */
export const BLOCK_TAGS: ReadonlySet<string> = new Set([
  "section",
  "header",
  "footer",
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "ul",
  "ol",
  "li",
  "table",
  "figure",
  "details",
  "pre",
  "blockquote",
]);

/** 内容不解析字符引用、也不解析标签的元素：序列化时原样输出，绝不转义。 */
export const RAW_TEXT_TAGS: ReadonlySet<string> = new Set([
  "script",
  "style",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
]);

/** 内容是文本但字符引用仍会解析（RCDATA）：序列化按普通文本转义，否则会掉 `&amp;`。 */
export const RCDATA_TAGS: ReadonlySet<string> = new Set(["textarea", "title"]);

/** HTML 规范的空元素：没有闭合标签，序列化必须自闭合。 */
export const VOID_TAGS: ReadonlySet<string> = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

export const COMPONENT_ATTRIBUTE = "data-hr-component";
export const HR_ID_ATTRIBUTE = "data-hr-id";
export const META_SCRIPT_ID = "hr-meta";

/** 合法 `data-hr-id`：非空、无空白、字符集 `[a-z0-9-]`。 */
export const HR_ID_PATTERN = /^[a-z0-9-]+$/;

/** ---------------------------- 数据模型 ---------------------------- */

export type HtmlAttribute = readonly [name: string, value: string];

interface HtmlDocumentNode {
  readonly kind: "document";
  readonly children: readonly HtmlNode[];
}

/** doctype 保留 public/system 标识，否则往返会把带标识的文档降级成 `<!DOCTYPE html>`。 */
export interface HtmlDoctypeNode {
  readonly kind: "doctype";
  readonly name: string;
  readonly publicId: string;
  readonly systemId: string;
}

/** attrs 保序且允许重名（重名诊断由解析层发，树不偷偷去重）。 */
export interface HtmlElementNode {
  readonly kind: "element";
  readonly tag: string;
  readonly attrs: readonly HtmlAttribute[];
  readonly children: readonly HtmlNode[];
}

interface HtmlTextNode {
  readonly kind: "text";
  readonly value: string;
}

interface HtmlCommentNode {
  readonly kind: "comment";
  readonly data: string;
}

export type HtmlNode =
  HtmlDocumentNode | HtmlDoctypeNode | HtmlElementNode | HtmlTextNode | HtmlCommentNode;

/** 闭合集合：新增值必须走卡片修订，禁止用自由字符串绕道。 */
export type DiagnosticCode =
  | "unclosed_tag"
  | "misnested_tag"
  | "duplicate_attribute"
  | "invalid_component"
  | "invalid_hr_id"
  | "script_in_meta"
  | "empty_document";

export type DiagnosticSeverity = "error" | "warning";

/**
 * 按码定级：错嵌套是结构被外力改写（后续语义层必须知道），未闭合多由容错解析吸收。
 * 分档表放这里，避免各处自己写 `severity: "warning"` 让 `"error"` 成为死值。
 */
export const DIAGNOSTIC_SEVERITY: Readonly<Record<DiagnosticCode, DiagnosticSeverity>> = {
  unclosed_tag: "warning",
  misnested_tag: "error",
  duplicate_attribute: "warning",
  invalid_component: "warning",
  invalid_hr_id: "warning",
  script_in_meta: "warning",
  empty_document: "warning",
};

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  /** 节点定位串（`article[0]>section[1]>p[2]`）；解析器级错误没有定位。 */
  readonly path?: string;
}

export interface ParsedHtml {
  readonly root: HtmlNode;
  readonly diagnostics: readonly Diagnostic[];
}
