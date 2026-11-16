// 这层管：模型响应文本 → `Suggestions`（逐字段校验、有据丢弃、永不抛）+ "能不能用"的判据；不合并。

import type { ExampleSpec } from "../../contracts";

/** `persona` 上限（卡 §4）；超了整字段丢弃而不是截断——半截人格比没有人格更坏。 */
const MAX_PERSONA_CHARS = 200;

/** 单条叙事规则 / `rhythm.style` / 单条 `forbidden` 的上限（卡 §4）。 */
const MAX_RULE_CHARS = 120;

/** 叙事规则条数上限（卡 §4）。 */
const MAX_RULES = 6;

/** 正反例组数上限（卡 §4）。 */
const MAX_EXAMPLES = 2;

/** 追加 `forbidden` 的条数上限：与统计层合用 24 条的总上限，这里先按总量拦。 */
const MAX_APPENDED_FORBIDDEN = 24;

/** 响应 `content` 的字节上限：超过就当整份不可解析，不再逐字段读一个几十 MB 的串。 */
const SUGGESTION_MAX_BYTES = 64 * 1024;

/** 顶层已知键；其余一律 `not_owned`（AC-3① 的"未知键"就靠这一条）。 */
const KNOWN_KEYS: readonly string[] = [
  "persona",
  "narrative_rules",
  "rhythm_style",
  "rhythm",
  "examples",
  "forbidden",
];

/** `rhythm` 子对象里只认 `style`；`max_paragraph_sentences` 由统计层独断（D3），出现即 `not_owned`。 */
const KNOWN_RHYTHM_KEYS: readonly string[] = ["style"];

export type DroppedReason = "not_owned" | "wrong_type" | "too_long" | "unparsable";

/** 每个被丢弃的建议都要留一条：`--json` 的 `dropped` 直接透出，用户才知道模型哪句没被采纳。 */
export interface Dropped {
  readonly field: string;
  readonly reason: DroppedReason;
}

/** 只含"建议"侧的字段：`forbidden` 恒有（空数组 = 没有追加），其余缺省表示"模型没给 / 给了不可用"。 */
export interface Suggestions {
  readonly persona?: string;
  readonly narrativeRules?: readonly string[];
  readonly rhythmStyle?: string;
  readonly examples?: readonly ExampleSpec[];
  readonly forbidden: readonly string[];
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const tryJson = (text: string): unknown => {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return undefined;
  }
};

/** 整份不可解析：空建议 + 一条 `unparsable`，调用方据此判"用户要的 LLM 萃取没拿到"。 */
const unparsableOf = (
  field: string,
): { readonly suggestions: Suggestions; readonly dropped: readonly Dropped[] } => ({
  suggestions: { forbidden: [] },
  dropped: [{ field, reason: "unparsable" }],
});

/** 依次穿过 `choices[0].message.content`：任何一层不是期望的形状都归到"整份不可解析"。 */
const contentTextOf = (raw: string): string | undefined => {
  const root = tryJson(raw);
  if (!isRecord(root)) return undefined;
  const choices = root["choices"];
  if (!Array.isArray(choices)) return undefined;
  const choice: unknown = choices[0];
  if (!isRecord(choice)) return undefined;
  const message = choice["message"];
  if (!isRecord(message)) return undefined;
  return typeof message["content"] === "string" ? message["content"] : undefined;
};

const reportUnknown = (
  body: Readonly<Record<string, unknown>>,
  known: readonly string[],
  prefix: string,
  dropped: Dropped[],
): void => {
  for (const key of Object.keys(body)) {
    if (!known.includes(key)) dropped.push({ field: `${prefix}${key}`, reason: "not_owned" });
  }
};

const trimmedOf = (value: unknown): string | undefined =>
  typeof value === "string" ? value.trim() : undefined;

interface TextFieldSpec {
  readonly key: string;
  /** 进 `dropped` 的字段名：子对象里的键要带上前缀（`rhythm.style`）。 */
  readonly field: string;
  readonly maxChars: number;
}

/** 单值文本字段：类型错 → `wrong_type`，超长 → `too_long`，都不抛。 */
const textFieldOf = (
  body: Readonly<Record<string, unknown>>,
  spec: TextFieldSpec,
  dropped: Dropped[],
): string | undefined => {
  const value = body[spec.key];
  if (value === undefined) return undefined;
  const text = trimmedOf(value);
  if (text === undefined || text.length === 0) {
    dropped.push({ field: spec.field, reason: "wrong_type" });
    return undefined;
  }
  if (text.length > spec.maxChars) {
    dropped.push({ field: spec.field, reason: "too_long" });
    return undefined;
  }
  return text;
};

/** 逐项筛字符串列表：坏项按 `name[index]` 记一条并跳过，不因一项坏掉丢掉整个字段。 */
const itemsOf = (
  value: readonly unknown[],
  field: string,
  maxChars: number,
  dropped: Dropped[],
): readonly string[] => {
  const items: string[] = [];
  value.forEach((item, index) => {
    const text = trimmedOf(item);
    const at = `${field}[${String(index)}]`;
    if (text === undefined || text.length === 0) {
      dropped.push({ field: at, reason: "wrong_type" });
    } else if (text.length > maxChars) {
      dropped.push({ field: at, reason: "too_long" });
    } else {
      items.push(text);
    }
  });
  return items;
};

interface ListFieldSpec {
  readonly key: string;
  readonly maxChars: number;
  readonly maxItems: number;
}

const listFieldOf = (
  body: Readonly<Record<string, unknown>>,
  spec: ListFieldSpec,
  dropped: Dropped[],
): readonly string[] | undefined => {
  const value = body[spec.key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    dropped.push({ field: spec.key, reason: "wrong_type" });
    return undefined;
  }
  const items = itemsOf(value, spec.key, spec.maxChars, dropped);
  if (items.length <= spec.maxItems) return items;
  dropped.push({ field: spec.key, reason: "too_long" });
  return items.slice(0, spec.maxItems);
};

const pairOf = (item: unknown, at: string, dropped: Dropped[]): ExampleSpec | undefined => {
  if (!isRecord(item)) {
    dropped.push({ field: at, reason: "wrong_type" });
    return undefined;
  }
  const bad = trimmedOf(item["bad"]);
  const good = trimmedOf(item["good"]);
  if (bad === undefined || good === undefined || bad.length === 0 || good.length === 0) {
    dropped.push({ field: at, reason: "wrong_type" });
    return undefined;
  }
  return { bad, good };
};

const examplesOf = (
  body: Readonly<Record<string, unknown>>,
  dropped: Dropped[],
): readonly ExampleSpec[] | undefined => {
  const value = body["examples"];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    dropped.push({ field: "examples", reason: "wrong_type" });
    return undefined;
  }
  const examples = value
    .map((item, index) => pairOf(item, `examples[${String(index)}]`, dropped))
    .filter((example): example is ExampleSpec => example !== undefined);
  if (examples.length <= MAX_EXAMPLES) return examples;
  dropped.push({ field: "examples", reason: "too_long" });
  return examples.slice(0, MAX_EXAMPLES);
};

/**
 * 节奏描述：扁平的 `rhythm_style` 是 prompt 要的键，**也是权威**——它出现时 `rhythm` 对象整体记
 * `not_owned` 后不再解析（避免两处各解析出一个值再比先后）；扁平键缺席时才收 `rhythm.style`，
 * 其中 `max_paragraph_sentences` 由统计层独断（D3），出现即 `not_owned`。
 */
const rhythmStyleOf = (
  body: Readonly<Record<string, unknown>>,
  dropped: Dropped[],
): string | undefined => {
  const rhythm = body["rhythm"];
  const flat = textFieldOf(
    body,
    { key: "rhythm_style", field: "rhythm_style", maxChars: MAX_RULE_CHARS },
    dropped,
  );
  if (flat !== undefined) {
    if (rhythm !== undefined) dropped.push({ field: "rhythm", reason: "not_owned" });
    return flat;
  }
  if (rhythm === undefined) return undefined;
  if (!isRecord(rhythm)) {
    dropped.push({ field: "rhythm", reason: "wrong_type" });
    return undefined;
  }
  reportUnknown(rhythm, KNOWN_RHYTHM_KEYS, "rhythm.", dropped);
  return textFieldOf(
    rhythm,
    { key: "style", field: "rhythm.style", maxChars: MAX_RULE_CHARS },
    dropped,
  );
};

/**
 * "这份建议能不能用"（AC-3②，B 案判据）：整份不可解析，或四个"模型才有"的字段全空，都算用户要的
 * LLM 萃取没拿到——CLI 据此报 `llm_failure`；`forbidden` 只是追加项，不参与判断。
 */
export const llmUsableOf = (dropped: readonly Dropped[], suggestions: Suggestions): boolean => {
  if (dropped.some((item) => item.reason === "unparsable")) return false;
  return (
    suggestions.persona !== undefined ||
    (suggestions.narrativeRules ?? []).length > 0 ||
    suggestions.rhythmStyle !== undefined ||
    (suggestions.examples ?? []).length > 0
  );
};

/** 逐个字段读；每个字段的失败都只丢自己、记一条 `dropped`，不影响其它字段。 */
const fieldsOf = (body: Readonly<Record<string, unknown>>, dropped: Dropped[]): Suggestions => {
  reportUnknown(body, KNOWN_KEYS, "", dropped);
  const persona = textFieldOf(
    body,
    { key: "persona", field: "persona", maxChars: MAX_PERSONA_CHARS },
    dropped,
  );
  const narrativeRules = listFieldOf(
    body,
    { key: "narrative_rules", maxChars: MAX_RULE_CHARS, maxItems: MAX_RULES },
    dropped,
  );
  const rhythmStyle = rhythmStyleOf(body, dropped);
  const examples = examplesOf(body, dropped);
  const forbidden =
    listFieldOf(
      body,
      { key: "forbidden", maxChars: MAX_RULE_CHARS, maxItems: MAX_APPENDED_FORBIDDEN },
      dropped,
    ) ?? [];
  // `exactOptionalPropertyTypes`：缺省必须是"键不存在"，不能是"键为 undefined"。
  const suggestions: Suggestions = {
    forbidden,
    ...(persona === undefined ? {} : { persona }),
    ...(narrativeRules === undefined ? {} : { narrativeRules }),
    ...(rhythmStyle === undefined ? {} : { rhythmStyle }),
    ...(examples === undefined ? {} : { examples }),
  };
  return suggestions;
};

/**
 * 模型响应 → 建议。**永不抛**：坏 JSON、形状不对、超长都退化成空建议 + `dropped`，
 * 是否"不可用"由 `llmUsableOf` 判定；本函数不造第二套校验。
 */
export const suggestionsOf = (
  raw: string,
): { readonly suggestions: Suggestions; readonly dropped: readonly Dropped[] } => {
  const content = contentTextOf(raw);
  if (content === undefined) return unparsableOf("choices[0].message.content");
  if (new TextEncoder().encode(content).length > SUGGESTION_MAX_BYTES) {
    return { suggestions: { forbidden: [] }, dropped: [{ field: "content", reason: "too_long" }] };
  }
  // `content` 本身还得是 JSON 对象：模型习惯在里面再包一层结构。
  const body = tryJson(content);
  if (!isRecord(body)) return unparsableOf("content");
  const dropped: Dropped[] = [];

  return { suggestions: fieldsOf(body, dropped), dropped };
};
