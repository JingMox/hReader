// 这层管：段落 → 统计量（句数 P75、句长均值、forbidden 候选、实词 top16）；不切分段落、不组装风格。

import {
  MAX_FORBIDDEN,
  MAX_PARAGRAPH_SENTENCES,
  MAX_RECOMMENDED,
  MIN_PARAGRAPH_SENTENCES,
} from "./contracts";
import type { ExtractStats } from "./contracts";
import { FILLER_PHRASES, STOPWORD_BIGRAMS } from "./fillers";
import { sentenceCountOf } from "./paragraphs";

const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff]/u;

const P75 = 0.75;

/** 线性插值分位数（未取整）：调用方负责 floor 与夹取。
 *
 * @internal 仅供统计层与边界测试使用（`[]` 与单元素两分支真实输入触不到）。
 */
export const percentileOf = (sorted: readonly number[], fraction: number): number => {
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowValue = sorted[lower] ?? 0;
  const highValue = sorted[upper] ?? lowValue;
  return lowValue + (highValue - lowValue) * (position - lower);
};

const totalSentencesOf = (paragraphs: readonly string[]): number =>
  paragraphs.reduce((sum, paragraph) => sum + sentenceCountOf(paragraph), 0);

/**
 * 卡 §10 R6：取 P75 而不是 P25——"每段最多几句"是上限语义，下四分位会让生成文本比语料更碎。
 * 插值后 floor，再夹到 [2,5]（`spec.ts` 只要求正整数，区间是本卡的软约束）。
 */
export const maxParagraphSentencesOf = (paragraphs: readonly string[]): number => {
  const sorted = paragraphs.map(sentenceCountOf).sort((left, right) => left - right);
  const raw = Math.floor(percentileOf(sorted, P75));
  return Math.min(MAX_PARAGRAPH_SENTENCES, Math.max(MIN_PARAGRAPH_SENTENCES, raw));
};

export const averageSentenceCharsOf = (paragraphs: readonly string[]): number => {
  const sentences = totalSentencesOf(paragraphs);
  if (sentences === 0) return 0;
  const chars = paragraphs.reduce((sum, paragraph) => sum + paragraph.length, 0);
  return Math.round(chars / sentences);
};

export const statisticsOf = (paragraphs: readonly string[]): ExtractStats => ({
  paragraphs: paragraphs.length,
  sentences: totalSentencesOf(paragraphs),
  averageSentenceChars: averageSentenceCharsOf(paragraphs),
  maxParagraphSentences: maxParagraphSentencesOf(paragraphs),
});

/** 卡 §10 R5：作者真用过的词不进 `forbidden`，否则等于要求作者别再写自己常写的字。 */
export const forbiddenPhrasesOf = (corpusText: string): readonly string[] =>
  FILLER_PHRASES.filter((phrase) => !corpusText.includes(phrase)).slice(0, MAX_FORBIDDEN);

const isCjk = (char: string): boolean => CJK_CHAR.test(char);

/** 中文没有分词器：只取 CJK 二元组，跨标点/跨语种的组合自然被跳过。 */
const bigramsOf = (corpusText: string): readonly string[] => {
  const bigrams: string[] = [];
  for (let index = 0; index + 1 < corpusText.length; index += 1) {
    const pair = corpusText.slice(index, index + 2);
    if (isCjk(pair.charAt(0)) && isCjk(pair.charAt(1))) bigrams.push(pair);
  }
  return bigrams;
};

/**
 * 卡 §10 R5 的输出契约：频次降序、同频按 Unicode 码位升序。
 *
 * @internal 只给单测：`sort` 只会拿两个不同条目来问，`left === right` 那一支真实排序到不了，
 * 而"同键回 0"是契约的一部分，所以导出后直接断言。
 */
export const byFrequencyThenCodepoint = (
  left: readonly [string, number],
  right: readonly [string, number],
): number => {
  if (left[1] !== right[1]) return right[1] - left[1];
  if (left[0] === right[0]) return 0;
  return left[0] < right[0] ? -1 : 1;
};

/** 卡 §10 R5：频次降序、同频按 Unicode 码位升序——换台机器也必须是同一个 16 条。 */
export const recommendedWordsOf = (corpusText: string): readonly string[] => {
  const counts = new Map<string, number>();
  for (const bigram of bigramsOf(corpusText)) {
    if (STOPWORD_BIGRAMS.includes(bigram)) continue;
    counts.set(bigram, (counts.get(bigram) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(byFrequencyThenCodepoint)
    .slice(0, MAX_RECOMMENDED)
    .map(([word]) => word);
};
