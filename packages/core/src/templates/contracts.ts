// This layer: template model vocabulary（manifest、来源、结果与诊断类型、容量上限）；
// 纯数据类型与常量，不含逻辑、不碰 IO。

import type { PatchDeps } from "../io/ports";

/** 模板 id 的合法形：kebab-case。它会拼进磁盘路径，任何含 `..`/`/`/`\`/NUL/大写/超长的串都过不了。 */
export const TEMPLATE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;

/** 单个模板目录的容量闸（防压缩包级滥用）；内置模板天然满足。 */
export const TEMPLATE_MAX_BYTES = 20 * 1024 * 1024;
export const TEMPLATE_MAX_FILES = 1000;

/** 清单文件名与三个成员缺省路径（manifest 省略字段时的生效值）。 */
export const MANIFEST_FILE = "template.json";
export const DEFAULT_ENTRY = "index.html";
export const DEFAULT_STYLE = "style.css";
export const DEFAULT_GUIDE = "guide.md";
export const ASSETS_DIR = "assets";

/** 模板目录在三级根下的相对位置：`<home>/.hreader/templates` 与 `<workspace>/.hreader/templates`。 */
export const TEMPLATES_DIRNAME = "templates";

export type TemplateSource = "builtin" | "user" | "workspace";

export type TemplateFormat = "html" | "managed";

/**
 * `template.json` 解析后的形状：键名与文件里一致（snake_case 不适用——manifest 本就是 JSON）。
 * `entry`/`style`/`guide` 保留**作者写的值**（未写时是 `undefined`），生效路径见各字段上的缺省常量；
 * 这样"显式写了但文件不在"与"没写走缺省"两种情形才分得出。
 */
export interface TemplateManifest {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: 1;
  readonly format: TemplateFormat;
  readonly entry?: string;
  readonly style?: string;
  readonly guide?: string;
  readonly tags: readonly string[];
}

export interface TemplateRoots {
  /** 工作区根：工作区级模板在 `<workspace>/.hreader/templates`。 */
  readonly workspace: string;
}

/** 与 `StyleDeps.home` 同口径：用户级模板在 `<home>/.hreader/templates`；测试注入临时目录。 */
export interface TemplateDeps extends PatchDeps {
  readonly home: string;
}

/** `listTemplates` 的一个条目：manifest 摘要 + 来源。 */
export interface TemplateSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly format: TemplateFormat;
  readonly tags: readonly string[];
  readonly source: TemplateSource;
}

/** 被跳过的损坏模板：`id` 拿不到时记目录名。 */
export interface TemplateDiagnostic {
  readonly id: string;
  readonly source: TemplateSource;
  readonly message: string;
}

export interface TemplateList {
  readonly templates: readonly TemplateSummary[];
  /** 每个损坏模板一条（含被高优先级同名模板遮住的）：坏一个不该拖垮整份清单。 */
  readonly diagnostics: readonly TemplateDiagnostic[];
}

/** `readTemplate` 的完整载荷：manifest + 三个成员文本 + 资源清单（相对模板根、含 `assets/` 前缀）。 */
export interface LoadedTemplate {
  readonly manifest: TemplateManifest;
  readonly source: TemplateSource;
  readonly entry: string;
  readonly style?: string;
  readonly guide?: string;
  readonly assets: readonly string[];
}

export interface CreateFromTemplateInput {
  readonly id: string;
  /** 相对 workspace 的目标路径（与 `resolveTarget` 的 `file` 同契约）；已存在即 `file_exists`。 */
  readonly target: string;
  /** 纯文本标题：写进 `<title>` 与首个 `<h1>`；省略时保留模板自带的标题。 */
  readonly title?: string;
}

export interface CreateFromTemplateResult {
  /** 落点相对 workspace 真实路径的正斜杠路径。 */
  readonly path: string;
  readonly bytes: number;
  /** 实际写出的资源文件（相对 workspace 的正斜杠路径）。 */
  readonly assets: readonly string[];
}
