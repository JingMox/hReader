// 这层管：`StyleSpec` → YAML 文本（键序固定、标量一律双引号）；不校验语义、不落盘。

import { stringify } from "yaml";

import type { StyleSpec } from "../contracts";

/**
 * 空列表输出为 `[]`（键后面什么都不写在 YAML 里是 null，会被严格解析器判成类型错）；
 * `lineWidth: 0` 关掉折行，`aliasDuplicateObjects: false` 避免共享数组被写成 `&a1` / `*a1`。
 *
 * @internal 只给 extract 自身与序列化边界测试用；对外入口是 `extractStyle`。
 */
export const styleYamlOf = (spec: StyleSpec): string => {
  const { language } = spec;
  return stringify(
    {
      id: spec.id,
      name: spec.name,
      description: spec.description,
      inherits_visual: spec.inheritsVisual,
      language_style: {
        persona: language.persona,
        narrative_rules: language.narrativeRules,
        sentence_rhythm: {
          max_paragraph_sentences: language.rhythm.maxParagraphSentences,
          style: language.rhythm.style,
        },
        vocabulary: {
          forbidden: language.vocabulary.forbidden,
          recommended: language.vocabulary.recommended,
        },
        examples: language.examples,
      },
    },
    {
      defaultStringType: "QUOTE_DOUBLE",
      defaultKeyType: "PLAIN",
      lineWidth: 0,
      aliasDuplicateObjects: false,
    },
  );
};
