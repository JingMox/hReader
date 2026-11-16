// 这层管：`StyleSpec` → YAML 文本（键序固定、标量一律双引号）；不校验语义、不落盘。

import type { ExampleSpec, StyleSpec } from "../contracts";

/** JSON 的字符串字面量是合法 YAML 双引号标量（转义集是子集）：借它避免自己发明转义规则。 */
const scalar = (value: string): string => JSON.stringify(value);

/** 空列表必须显式写 `[]`：YAML 里"键后面什么都不写"是 null，会被严格解析器判成类型错。 */
const blockList = (indent: string, key: string, items: readonly string[]): readonly string[] =>
  items.length === 0
    ? [`${indent}${key}: []`]
    : [`${indent}${key}:`, ...items.map((item) => `${indent}  - ${scalar(item)}`)];

const exampleLinesOf = (examples: readonly ExampleSpec[]): readonly string[] =>
  examples.length === 0
    ? ["  examples: []"]
    : [
        "  examples:",
        ...examples.flatMap((example) => [
          `    - bad: ${scalar(example.bad)}`,
          `      good: ${scalar(example.good)}`,
        ]),
      ];

/** @internal 只给 extract 自身与序列化边界测试用；对外入口是 `extractStyle`。 */
export const styleYamlOf = (spec: StyleSpec): string => {
  const { language } = spec;
  const lines = [
    `id: ${scalar(spec.id)}`,
    `name: ${scalar(spec.name)}`,
    `description: ${scalar(spec.description)}`,
    `inherits_visual: ${scalar(spec.inheritsVisual)}`,
    "language_style:",
    `  persona: ${scalar(language.persona)}`,
    ...blockList("  ", "narrative_rules", language.narrativeRules),
    "  sentence_rhythm:",
    `    max_paragraph_sentences: ${String(language.rhythm.maxParagraphSentences)}`,
    `    style: ${scalar(language.rhythm.style)}`,
    "  vocabulary:",
    ...blockList("    ", "forbidden", language.vocabulary.forbidden),
    ...blockList("    ", "recommended", language.vocabulary.recommended),
    ...exampleLinesOf(language.examples),
  ];
  return `${lines.join("\n")}\n`;
};
