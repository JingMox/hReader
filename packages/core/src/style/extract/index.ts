// 这层管：语料 → `style.yaml` 的纯统计路径（切分 → 统计 → 组装 → 序列化 → 自校验）；不碰网络与 io。

import { HrError } from "../../hr-error";
import { parseStyleText } from "../spec";

import { styleSpecOf } from "./compose";
import type { ExtractStyleInput, ExtractStyleResult } from "./contracts";
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
