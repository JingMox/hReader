// 这层管：`PromptInput` → 提示词文本（键序与拼接顺序固定、不读时钟/环境/随机）；不解析响应、不碰网络。

import { MAX_FORBIDDEN } from "../contracts";
import type { CorpusText, ExtractStats } from "../contracts";
import { PROMPT_MAX_CORPUS_BYTES } from "./port";
import type { Dropped } from "./suggest";

export interface PromptInput {
  readonly stats: ExtractStats;
  readonly corpus: readonly CorpusText[];
}

/** 语料块与它的截断记录：截断必须可见，否则模型拿到的是半篇还以为读了全篇。 */
export interface CorpusBlock {
  readonly text: string;
  readonly dropped: readonly Dropped[];
}

const textBytesOf = (text: string): number => new TextEncoder().encode(text).length;

/** 按码位截断（不能按 UTF-16 码元：切在代理对中间会产出半个字）。 */
const truncateToBytes = (text: string, limit: number): string => {
  if (textBytesOf(text) <= limit) return text;
  let kept = "";
  let used = 0;
  for (const char of text) {
    const size = textBytesOf(char);
    if (used + size > limit) break;
    kept += char;
    used += size;
  }
  return kept;
};

/**
 * 语料按文档顺序拼接（文档间空行分隔），超 `PROMPT_MAX_CORPUS_BYTES` 截断并记一条 `too_long`。
 * 截断是"尾部丢掉"而不是"每篇各取一段"：模型据此写人格，看完整的前半篇比看一堆碎片准。
 */
export const corpusBlockOf = (corpus: readonly CorpusText[]): CorpusBlock => {
  const joined = corpus.map((doc) => doc.text).join("\n\n");
  const text = truncateToBytes(joined, PROMPT_MAX_CORPUS_BYTES);
  return text === joined
    ? { text, dropped: [] }
    : { text, dropped: [{ field: "corpus", reason: "too_long" }] };
};

const statLinesOf = (stats: ExtractStats): readonly string[] => [
  `- 段落数：${String(stats.paragraphs)}`,
  `- 句数：${String(stats.sentences)}`,
  `- 平均句长：${String(stats.averageSentenceChars)} 字`,
  `- 每段句数上限：${String(stats.maxParagraphSentences)} 句（统计值，权威，不要在你的响应里给这个字段）`,
];

const SPEC_LINES = [
  "只输出一个 JSON 对象，不要 markdown 代码块，不要解释。允许的键：",
  '- "persona"：字符串，≤200 字，描述这位作者怎么说话。',
  '- "narrative_rules"：字符串数组，1..6 条，每条 ≤120 字，写成可执行的规则。',
  '- "rhythm_style"：字符串，≤120 字，描述句子节奏。',
  '- "examples"：数组，≤2 组，每项 {"bad": 字符串, "good": 字符串}。',
  `- "forbidden"：字符串数组，≤${String(MAX_FORBIDDEN)} 条，只放"这位作者不说的套话"，不要放他常用的词。`,
];

/**
 * 同一个 `PromptInput` 必须给出同一个字节串：纯字符串拼接，没有时间、随机数、
 * 环境变量；数组顺序即语料顺序，统计值一律经 `String()` 落地。
 */
export const promptOf = (input: PromptInput): string => {
  const { text } = corpusBlockOf(input.corpus);
  return [
    "你是中文写作风格分析器。下面给出一份统计结果和对应的语料，请归纳这位作者的写作风格。",
    "",
    "【统计结果】",
    ...statLinesOf(input.stats),
    "",
    "【语料】",
    "<<<",
    text,
    ">>>",
    "",
    ...SPEC_LINES,
  ].join("\n");
};
