// 这层管：风格引擎的纯数据类型（规格、命中、诊断、加载结果）；不含逻辑、不碰 IO。

import type { PatchDeps } from "../io/ports";

export interface SentenceRhythmSpec {
  /** 连续纯文字段落里允许的句子上限：超出即触发"三段一视觉法则"的改写提示。 */
  readonly maxParagraphSentences: number;
  /** 空串表示"不约束句式"：编译时整行跳过。 */
  readonly style: string;
}

export interface VocabularySpec {
  readonly forbidden: readonly string[];
  readonly recommended: readonly string[];
}

export interface ExampleSpec {
  readonly bad: string;
  readonly good: string;
}

export interface LanguageSpec {
  readonly persona: string;
  readonly narrativeRules: readonly string[];
  readonly rhythm: SentenceRhythmSpec;
  readonly vocabulary: VocabularySpec;
  readonly examples: readonly ExampleSpec[];
}

/** `style.yaml` 的模型：键名用 camelCase，映射在 `spec.ts` 里做（YAML 侧仍是 snake_case）。 */
export interface StyleSpec {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** 视觉维度：指向主题目录名（决定 `theme.css`），语言维度不随它继承。 */
  readonly inheritsVisual: string;
  readonly language: LanguageSpec;
}

export interface LintHit {
  /** 块 ID（`DocumentModel.id`）：偏移只在块内文本上有意义。 */
  readonly path: string;
  readonly word: string;
  /** 命中点周围的块内文本窗口，两端被截断时带 `…`。 */
  readonly excerpt: string;
  /** 命中词首个字符在块内文本里的 UTF-16 码元偏移（与 JS 字符串下标同域）。
   *
   * 归一化可能改变长度（`ﬁ` → `fi`、零宽被折叠），故 `slice(offset, offset + word.length)`
   * **不保证**切出命中词；需要原文时用 `excerpt`。
   */
  readonly offset: number;
}

export interface LintReport {
  readonly hits: readonly LintHit[];
  /** 至少一个块命中超过上限被截断：此时 `hits` 不是全量。 */
  readonly truncated: boolean;
}

/** 被发现流程跳过的坏文件：坏一个不许毁掉全部。 */
export interface StyleDiagnostic {
  readonly path: string;
  readonly reason: string;
}

export type StyleSource = "explicit" | "project" | "user" | "builtin";

export interface LoadedStyle {
  readonly spec: StyleSpec;
  readonly source: StyleSource;
  /** `theme.css` 的绝对路径：`applyStyle` 只从盘上读这一份。 */
  readonly themePath: string;
}

export interface LoadStyleInput {
  readonly id?: string;
  /** 显式 `style.yaml` 路径：优先级最高，与 `id` 同时给出时两者必须一致。 */
  readonly path?: string;
}

export interface StyleDiscovery {
  /** 自定义风格（项目级在前、用户级在后）；内置预设不在此列。 */
  readonly styles: readonly StyleSpec[];
  readonly diagnostics: readonly StyleDiagnostic[];
}

export interface StyleDeps extends PatchDeps {
  readonly home: string;
  readonly projectRoot: string;
  /** 内置 `themes/` 目录（`packages/core/themes/`）：主题与预设的静态资源根。 */
  readonly stylesRoot: string;
}

export interface ApplyStyleInput {
  readonly workspace: string;
  readonly file: string;
  readonly visualId: string;
}

export interface ApplyStyleResult {
  readonly path: string;
  readonly bytes: number;
  /** 同 `visualId` 重复应用为 `false`：此时不写盘（幂等）。 */
  readonly changed: boolean;
}
