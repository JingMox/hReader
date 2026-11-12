// 这层管：outline 的类型形状与各类上限；不遍历 DOM、不算字数、不裁字节。

import type { Diagnostic } from "../../html/constants";

/** 进 outline 的容器标签；`p`/`div`/列表/表格一律不进。 */
export const OUTLINE_TAGS: ReadonlySet<string> = new Set(["section", "header"]);

/** 这些容器的文本不可见：字数不计、子树不展开（`noscript` 是兜底可见内容，仍计）。 */
export const NON_VISIBLE_TEXT_TAGS: ReadonlySet<string> = new Set([
  "style",
  "script",
  "textarea",
  "template",
]);

/** 单节点标题文本上限（按码点计）：超出以 `…` 结尾。 */
export const OUTLINE_TEXT_LIMIT = 120;

/** 批注 `comment` 上限（按码点计）。 */
export const OUTLINE_ANNOTATION_LIMIT = 200;

/** 结构深度上限：article(0) → 顶层节点(1) → … → 第 4 层，再深的不再展开。 */
export const OUTLINE_DEPTH_LIMIT = 4;

/** 1MB 文档 `JSON.stringify(outline)` 的预算。 */
export const OUTLINE_BYTE_LIMIT = 8192;

/** 批注先占的份额（约 3/10 预算）：批注是 `hr_outline` 的主要交付物之一，不能被长树全挤掉。 */
export const OUTLINE_ANNOTATION_BYTE_LIMIT = 2304;

/** 诊断段的字节上限：与节点/批注同属 8KB 预算，超出就按 code 折叠。 */
export const OUTLINE_DIAGNOSTIC_BYTE_LIMIT = 1024;

/** 同一 `code` 最多保留几条（同 code 且同 message 的先折叠成一条计数）。 */
export const OUTLINE_DIAGNOSTIC_PER_CODE = 3;

/** 长度给截断诊断预留的字节数：诊断段上限 + 报文里的计数位。 */
export const OUTLINE_RESERVE_BYTES = OUTLINE_DIAGNOSTIC_BYTE_LIMIT + 512;

/** 预算搜索前先按节点数粗裁，避免在万级树上反复序列化。 */
export const OUTLINE_NODE_SCAN_LIMIT = 1024;

export interface OutlineNode {
  readonly id: string;
  readonly tag: string;
  /** 标题取 1–4；section/header 取其首个标题的层级，无标题则继承父级、顶层记 0。 */
  readonly level: number;
  readonly text: string;
  /** 该节点子树字数（与 `Outline.wordCount` 同一规则）。 */
  readonly wordCount: number;
  readonly children: readonly OutlineNode[];
}

export interface PendingAnnotation {
  readonly id: string;
  readonly targetId: string;
  readonly comment: string;
}

export interface Outline {
  readonly nodes: readonly OutlineNode[];
  readonly pendingAnnotations: readonly PendingAnnotation[];
  readonly wordCount: number;
  readonly diagnostics: readonly Diagnostic[];
}
