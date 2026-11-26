// 这层管：本层的词表与数据模型（元素/组件/属性/诊断码 + HTML 树与诊断类型）；不含逻辑。
// 类型与常量放同一文件：v8 对纯类型模块记 0% 覆盖，perFile 100% 门禁下单独的类型文件永远不可达。

/**
 * `data-hr-component` 的合法取值词表（语义组件）；`media-card` 是后加的（音视频统一外壳）。
 * 每个取值的结构规约在 `layout/components.ts`，两边必须一一对应。
 */
export const COMPONENT_WHITELIST: readonly string[] = [
  "kpi-bento",
  "callout-insight",
  "callout-warning",
  "split-compare",
  "deep-dive",
  "step-timeline",
  "diagram-stage",
  "media-card",
];

/** 文档容器标签：模型根、注入目标的锚点（`<article>` 自身也注入）。 */
export const ARTICLE_TAG = "article";

/**
 * 内容模型口径的块级标签：只回答"派生文档模型时这个元素是不是块级"，不回答"能不能被寻址/当 patch 目标"。
 * 寻址面比它宽（`div`、表格内部都要能被批注和 patch 命中），见 `ADDRESSABLE_TAGS`。
 */
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

/**
 * 可寻址集合：`hr normalize` 会给这些元素分配 `data-hr-id`，因此也是 `read`/`patch`/批注的可达面。
 * = 内容模型块级（`BLOCK_TAGS`）∪ 常见块级容器 ∪ 表格结构。
 *
 * 与 `BLOCK_TAGS` 的关系（三者不是同一个集合，别合并）：`BLOCK_TAGS` 管内容模型投影，本集合管"有没有 id"，
 * `PATCHABLE_TAGS` 管"能不能被改"。加了一个块级容器却忘了加在这里，症状就是它拿不到 id、批注无处可挂。
 * `<article>` 放在这里是为了让 `PATCHABLE_TAGS` 能按 id 命中 `<article>`；最外层/嵌套 article 的注入判定由 `html/inject.ts:39` 的 tag 分支直接做（tag 为 article 时走第一分支，本集合的 has("article") 不被求值）。
 */
export const ADDRESSABLE_TAGS: ReadonlySet<string> = new Set([
  ...BLOCK_TAGS,
  "h5",
  "h6",
  "div",
  "aside",
  "nav",
  "main",
  "article",
  "dl",
  "dt",
  "dd",
  "figcaption",
  "caption",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
]);

/**
 * 可作 `hr patch` 目标的标签：默认与 `ADDRESSABLE_TAGS` 同集（能拿到 id 的都能被改）。
 * "可寻址但不可作目标"只能在这里表达（从集合里减掉 + 写清理由），不许在 `isPatchableTarget` 里加 if 链。
 * 当前例外为空：目标里面能装什么由 `ops/patch-node/content.ts` 的内容模型判，与"能不能当目标"正交。
 */
// 独立实例（不是 `ADDRESSABLE_TAGS` 的别名）：两套口径要能分开演进，减项不许传染寻址面。
export const PATCHABLE_TAGS: ReadonlySet<string> = new Set(ADDRESSABLE_TAGS);

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

/** 合法 `data-hr-id`：字母打头，余下字母/数字/`_`/`-`，总长 ≤ 64。 */
export const HR_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * 开局这些块级标签时 `<p>` 的隐式结束（HTML5 “in body” 插入模式）：
 * parse5 只在 no-quirks 下把 `<table>` 移出 `<p>`，quirks 文档（无 doctype）会把 `p > table` 整棵留下来，
 * 那种树会被后续内容模型判为非法。收尾按本集合统一补隐式结束。
 */
export const P_CLOSING_TAGS: ReadonlySet<string> = new Set([
  "p",
  "table",
  "ul",
  "ol",
  "dl",
  "div",
  "section",
  "article",
  "aside",
  "nav",
  "main",
  "header",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "hr",
  "figure",
  "details",
  "address",
]);

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
/** 元素在**原始输入字符串**中的区间（仅 `locations: true` 时填充）：区间拼接只碰这三段边界。 */
export interface SourceSpan {
  /** `<p` 的起始 offset。 */
  readonly start: number;
  /** `</p>` 之后的 offset（含结束标签）。 */
  readonly end: number;
  /** 开始标签末尾，即子节点区域的起点。 */
  readonly innerStart: number;
  /** 结束标签起点，即子节点区域的终点；无结束标签时等于 `end`。 */
  readonly innerEnd: number;
}

export interface HtmlElementNode {
  readonly kind: "element";
  readonly tag: string;
  readonly attrs: readonly HtmlAttribute[];
  readonly children: readonly HtmlNode[];
  /** 隐含生成的骨架元素没有源码位置，`parseHtml` 在 locations 模式下给零宽区间。 */
  readonly span?: SourceSpan;
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

/** Closed set: adding a value is a deliberate contract change here — no free-string detours. */
export type DiagnosticCode =
  | "unclosed_tag"
  | "misnested_tag"
  | "duplicate_attribute"
  | "invalid_component"
  | "invalid_hr_id"
  | "id_reassigned"
  | "fragment_ids_ignored"
  | "script_in_meta"
  | "empty_document"
  | "duplicate_id"
  | "missing_article"
  | "multiple_article"
  | "heading_level_jump"
  | "outline_node_without_id"
  | "outline_truncated"
  | "annotation_target_missing"
  | "invalid_meta"
  | "ambiguous_selector"
  | "stripped_shell"
  | "truncated_output"
  // 排版约束（`layout/check.ts`）：组件根标签不对 / 组件结构不全 / 内联 style
  | "component_root"
  | "component_shape"
  | "inline_style";

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
  id_reassigned: "warning",
  fragment_ids_ignored: "warning",
  script_in_meta: "warning",
  empty_document: "warning",
  duplicate_id: "error",
  missing_article: "error",
  multiple_article: "error",
  heading_level_jump: "warning",
  outline_node_without_id: "warning",
  outline_truncated: "warning",
  annotation_target_missing: "warning",
  invalid_meta: "warning",
  ambiguous_selector: "warning",
  stripped_shell: "warning",
  truncated_output: "warning",
  component_root: "warning",
  component_shape: "warning",
  inline_style: "warning",
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
