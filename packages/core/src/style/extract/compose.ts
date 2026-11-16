// 这层管：统计量 → `StyleSpec`（纯统计版的确定性模板）；不做统计、不序列化 YAML。

import type { StyleSpec } from "../contracts";
import type { ExtractStats, ExtractStyleInput } from "./contracts";

/** 模板里最多点三个常用词：再多就会撑破 `persona` 的 200 字上限。 */
const TOP_WORDS = 3;

/** `narrative_rules` 里最多点五个禁用词：单条规则要留在 120 字以内。 */
const RULE_WORDS = 5;

const wordsOf = (words: readonly string[]): string => words.slice(0, TOP_WORDS).join("、");

/** 各分段都是定长模板，最长不超过 100 字（卡 §4 的 200 字上限由此结构性成立，无需截断）。 */
const personaOf = (stats: ExtractStats, recommended: readonly string[]): string => {
  const head = `以 ${String(stats.averageSentenceChars)} 字左右的句子写作，每段不超过 ${String(stats.maxParagraphSentences)} 句`;
  const tail = recommended.length === 0 ? "" : `，常用词：${wordsOf(recommended)}`;
  return `${head}${tail}。`;
};

const narrativeRulesOf = (stats: ExtractStats, forbidden: readonly string[]): readonly string[] => {
  const rules = [`每段控制在 ${String(stats.maxParagraphSentences)} 句以内`];
  if (forbidden.length > 0) rules.push(`避免使用：${forbidden.slice(0, RULE_WORDS).join("、")}`);
  rules.push(`单句控制在 ${String(stats.averageSentenceChars)} 字左右`);
  return rules;
};

const descriptionOf = (input: ExtractStyleInput, stats: ExtractStats): string =>
  `由 ${String(input.corpus.length)} 篇语料统计生成：${String(stats.paragraphs)} 个段落、` +
  `${String(stats.sentences)} 句，平均句长 ${String(stats.averageSentenceChars)} 字。`;

export const styleSpecOf = (
  input: ExtractStyleInput,
  stats: ExtractStats,
  forbidden: readonly string[],
  recommended: readonly string[],
): StyleSpec => ({
  id: input.id,
  name: input.name,
  description: descriptionOf(input, stats),
  inheritsVisual: input.inheritsVisual,
  language: {
    persona: personaOf(stats, recommended),
    narrativeRules: narrativeRulesOf(stats, forbidden),
    rhythm: {
      maxParagraphSentences: stats.maxParagraphSentences,
      style: `平均句长约 ${String(stats.averageSentenceChars)} 字`,
    },
    vocabulary: { forbidden, recommended },
    // 纯统计版给不出正反例（卡 D2）：LLM 路径才填 `examples`。
    examples: [],
  },
});
