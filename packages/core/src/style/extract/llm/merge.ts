// 这层管：统计权威的 `StyleSpec` + 模型建议 → 合并后的 `StyleSpec`（数值与推荐词一律不动）；不校验、不序列化。

import type { LanguageSpec, StyleSpec } from "../../contracts";
import { MAX_FORBIDDEN } from "../contracts";
import type { Dropped, Suggestions } from "./suggest";

/**
 * 统计命中表在前、追加按响应顺序、首次出现为准（卡 §10 R5/D3）。
 * 满 24 条后不再追加，并记一条 `too_long`——不静默截断，用户能从 `--json` 看见被压掉的建议。
 */
const forbiddenOf = (
  stat: readonly string[],
  extra: readonly string[],
  dropped: Dropped[],
): readonly string[] => {
  const seen = new Set(stat);
  const merged = [...stat];
  let overflowed = false;
  for (const word of extra) {
    if (seen.has(word)) continue;
    seen.add(word);
    if (merged.length >= MAX_FORBIDDEN) {
      overflowed = true;
      continue;
    }
    merged.push(word);
  }
  if (overflowed) dropped.push({ field: "forbidden", reason: "too_long" });
  return merged;
};

/** 空数组/缺省一律回落统计版：`narrative_rules` 的空表会被严格校验拒掉（R7），`examples` 抹掉是净损失。 */
const firstNonEmpty = <T>(
  candidate: readonly T[] | undefined,
  fallback: readonly T[],
): readonly T[] => (candidate === undefined || candidate.length === 0 ? fallback : candidate);

const languageOf = (
  stat: LanguageSpec,
  suggestions: Suggestions,
  dropped: Dropped[],
): LanguageSpec => ({
  persona: suggestions.persona ?? stat.persona,
  narrativeRules: firstNonEmpty(suggestions.narrativeRules, stat.narrativeRules),
  rhythm: {
    // D3：句数上限只认统计值，模型给的同名字段在 `suggestionsOf` 就已按 `not_owned` 丢掉。
    maxParagraphSentences: stat.rhythm.maxParagraphSentences,
    style: suggestions.rhythmStyle ?? stat.rhythm.style,
  },
  vocabulary: {
    forbidden: forbiddenOf(stat.vocabulary.forbidden, suggestions.forbidden, dropped),
    recommended: stat.vocabulary.recommended,
  },
  examples: firstNonEmpty(suggestions.examples, stat.examples),
});

/**
 * 合并不抛：模型建议再离谱，最坏结果也只是"仍是统计版"。
 * 产物是否可救由调用方写盘前过 `parseStyleText` 判定（AC-3②），这里不造第二套校验。
 */
export const mergeSuggestions = (
  stat: StyleSpec,
  suggestions: Suggestions,
  dropped: readonly Dropped[],
): { readonly spec: StyleSpec; readonly dropped: readonly Dropped[] } => {
  const extra: Dropped[] = [];
  const language = languageOf(stat.language, suggestions, extra);
  return { spec: { ...stat, language }, dropped: [...dropped, ...extra] };
};
