// 这层管：语料 → `style.yaml` 的纯统计路径（切分 → 统计 → 组装 → 序列化 → 自校验）；不碰网络与 io。

import { HrError } from "../../hr-error";
import { parseStyleText } from "../spec";

import { styleSpecOf } from "./compose";
import type { ExtractStyleInput, ExtractStyleResult } from "./contracts";
import { mergeSuggestions } from "./llm/merge";
import type { LlmPort } from "./llm/port";
import { promptOf } from "./llm/prompt";
import { llmUsableOf, suggestionsOf } from "./llm/suggest";
import type { Dropped } from "./llm/suggest";
import { paragraphTextsOf } from "./paragraphs";
import { forbiddenPhrasesOf, recommendedWordsOf, statisticsOf } from "./stats";
import { styleYamlOf } from "./yaml";

export type {
  CorpusFormat,
  CorpusText,
  ExtractStats,
  ExtractStyleInput,
  ExtractStyleResult,
} from "./contracts";
export { PROMPT_MAX_CORPUS_BYTES } from "./llm/port";
export type { LlmPort } from "./llm/port";
export { corpusBlockOf, promptOf } from "./llm/prompt";
export type { CorpusBlock, PromptInput } from "./llm/prompt";
export { llmUsableOf, suggestionsOf } from "./llm/suggest";
export type { Dropped, DroppedReason, Suggestions } from "./llm/suggest";
export { mergeSuggestions } from "./llm/merge";

/**
 * 产物必须能过 `parseStyleText`：用例里断言"提取出的 YAML 能被 `loadStyle` 读回"
 * 依赖的就是这一步——序列化写错在这里当场暴露，而不是等到用户 `hr style` 才炸。
 */
export const extractStyle = (input: ExtractStyleInput): ExtractStyleResult => {
  const paragraphs = paragraphTextsOf(input.corpus);
  if (paragraphs.length === 0) {
    throw new HrError("invalid_input", "语料里没有可统计的正文段落（标题、代码块、表格不算段落）");
  }
  const stats = statisticsOf(paragraphs);
  const corpusText = paragraphs.join("\n");
  const forbidden = forbiddenPhrasesOf(corpusText);
  const recommended = recommendedWordsOf(corpusText);
  const yaml = styleYamlOf(styleSpecOf(input, stats, forbidden, recommended));
  return { spec: parseStyleText(yaml, input.id), yaml, stats };
};

/** LLM 组合层的输入：语料与元信息同 `ExtractStyleInput`，多的只有传输层（实现归 CLI）。 */
export interface ExtractStyleLlmInput extends ExtractStyleInput {
  readonly llm: LlmPort;
}

/** `spec`/`yaml` 已含建议；`dropped` 是模型响应里没被采纳的逐条事实（`--json` 透出用）。 */
export interface ExtractStyleLlmResult extends ExtractStyleResult {
  readonly dropped: readonly Dropped[];
}

/** 只取前 3 条：整份响应的丢弃项可能有几十条，全塞进 message 会把错误行撑成日志。 */
const droppedSummaryOf = (dropped: readonly Dropped[]): string =>
  dropped.length === 0
    ? "响应里没有可用的字段"
    : dropped
        .slice(0, 3)
        .map((item) => `${item.field}: ${item.reason}`)
        .join("；");

/**
 * 纯统计 → 提示词 → 一次补全 → 建议 → 合并 → 重新序列化 → 回读校验。
 * 建议不可用就整份失败（R23）：半统计半模型的产物比一次明确的失败更难查。
 * `stats` 原样透传统计层的结果，LLM 不参与任何统计口径（D3）。
 */
export const extractStyleWithLlm = async (
  input: ExtractStyleLlmInput,
): Promise<ExtractStyleLlmResult> => {
  const stat = extractStyle(input);
  const raw = await input.llm.complete(promptOf({ stats: stat.stats, corpus: input.corpus }));
  const parsed = suggestionsOf(raw);
  if (!llmUsableOf(parsed.suggestions)) {
    throw new HrError(
      "llm_failure",
      `模型没有返回可用的风格建议（${droppedSummaryOf(parsed.dropped)}）`,
    );
  }
  const merged = mergeSuggestions(stat.spec, parsed.suggestions, parsed.dropped);
  const yaml = styleYamlOf(merged.spec);
  return { spec: parseStyleText(yaml, input.id), yaml, stats: stat.stats, dropped: merged.dropped };
};
