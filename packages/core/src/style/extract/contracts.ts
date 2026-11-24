// 这层管：语料 → 风格产物的输入/输出类型与本卡的上限常量；不含逻辑、不碰 IO。

import type { StyleSpec } from "../contracts";

/** 只影响段落切分（Markdown 行块 vs HTML 块元素），不影响统计口径。 */
export type CorpusFormat = "markdown" | "html";

export interface CorpusText {
  readonly format: CorpusFormat;
  readonly text: string;
}

export interface ExtractStyleInput {
  readonly corpus: readonly CorpusText[];
  readonly id: string;
  readonly name: string;
  readonly inheritsVisual: string;
}

/** 统计量随产物返回：`--json` 直接透出，调用方不必重算（P75 值就是这一项）。 */
export interface ExtractStats {
  readonly paragraphs: number;
  readonly sentences: number;
  readonly averageSentenceChars: number;
  readonly maxParagraphSentences: number;
}

export interface ExtractStyleResult {
  readonly spec: StyleSpec;
  readonly yaml: string;
  readonly stats: ExtractStats;
}

/**
 * 硬上限：`forbidden` 24 条、`recommended` 16 条。
 * 统计层由套话表长度（恰好 24）兜底，这条上限还不 binding；LLM 追加工序才真正撞上它。
 */
export const MAX_FORBIDDEN = 24;

export const MAX_RECOMMENDED = 16;

/** "最多几句"的软区间：P75 落在此区间外就夹到端点。 */
export const MIN_PARAGRAPH_SENTENCES = 2;

export const MAX_PARAGRAPH_SENTENCES = 5;
