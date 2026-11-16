// 这层管：模型响应文本 → `Suggestions`（逐字段校验、丢弃有据、永不抛）；不合并、不组装产物。

import type { ExampleSpec } from "../../contracts";

/** `persona` 上限（卡 §4）；超了整字段丢弃而不是截断——半截人格比没有人格更坏。 */
const MAX_PERSONA_CHARS = 200;

/** 单条叙事规则上限（卡 §4）。 */
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

const textBytesOf = (text: string): number => new TextEncoder().encode(text).length;

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

/** 整份不可解析：空建议 + 一条 `unparsable`，调用方据此回落到纯统计版（AC-3①）。 */
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
  const content = message["content"];
  return typeof content === "string" ? content : undefined;
};

/** `content` 本身还得是 JSON 对象：模型习惯在里面再包一层结构。 */
const bodyOf = (content: string): Readonly<Record<string, unknown>> | undefined => {
  const body = tryJson(content);
  return isRecord(body) ? body : undefined;
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

/** 单值文本字段：类型错 → `wrong_type`，超长 → `too_long`，都不抛。 */
const textFieldOf = (
  body: Readonly<Record<string, unknown>>,
  key: string,
  maxChars: number,
  dropped: Dropped[],
): string | undefined => {
  const value = body[key];
  if (value === undefined) return undefined;
  const text = trimmedOf(value);
  if (text === undefined || text.length === 0) {
    dropped.push({ field: key, reason: "wrong_type" });
    return undefined;
  }
  if (text.length > maxChars) {
    dropped.push({ field: key, reason: "too_long" });
    return undefined;
  }
  return text;
};

/** 逐项筛字符串列表：坏项记一条并跳过，不因一项坏掉丢掉整个字段。 */
const itemsOf = (
  value: readonly unknown[],
  key: string,
  maxChars: number,
  dropped: Dropped[],
): readonly string[] => {
  const items: string[] = [];
  for (const item of value) {
    const text = trimmedOf(item);
    if (text === undefined || text.length === 0) {
      dropped.push({ field: key, reason: "wrong_type" });
    } else if (text.length > maxChars) {
      dropped.push({ field: key, reason: "too_long" });
    } else {
      items.push(text);
    }
  }
  return items;
};

const listFieldOf = (
  body: Readonly<Record<string, unknown>>,
  key: string,
  limits: { readonly maxChars: number; readonly maxItems: number },
  dropped: Dropped[],
): readonly string[] | undefined => {
  const value = body[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    dropped.push({ field: key, reason: "wrong_type" });
    return undefined;
  }
  const items = itemsOf(value, key, limits.maxChars, dropped);
  if (items.length <= limits.maxItems) return items;
  dropped.push({ field: key, reason: "too_long" });
  return items.slice(0, limits.maxItems);
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

/** `rhythm_style` 是 prompt 里要的扁平键；`rhythm` 对象形式是模型常见的模仿统计结构的写法，也收，
 * 但只取 `style`：`max_paragraph_sentences` 出现即 `not_owned`（统计值是权威，D3）。 */
const rhythmStyleOf = (
  body: Readonly<Record<string, unknown>>,
  dropped: Dropped[],
): string | undefined => {
  const flat = textFieldOf(body, "rhythm_style", MAX_RULE_CHARS, dropped);
  if (flat !== undefined) return flat;
  const rhythm = body["rhythm"];
  if (rhythm === undefined) return undefined;
  if (!isRecord(rhythm)) {
    dropped.push({ field: "rhythm", reason: "wrong_type" });
    return undefined;
  }
  reportUnknown(rhythm, KNOWN_RHYTHM_KEYS, "rhythm.", dropped);
  return textFieldOf(rhythm, "style", MAX_RULE_CHARS, dropped);
};

/**
 * 模型响应 → 建议。**永不抛**：坏 JSON、形状不对、超长都退化成空建议 + `dropped`，
 * 由调用方回落到纯统计版；"整份产物不可救"由合并后的严格校验暴露，这里不造第二套校验。
 */
export const suggestionsOf = (
  raw: string,
): { readonly suggestions: Suggestions; readonly dropped: readonly Dropped[] } => {
  const content = contentTextOf(raw);
  if (content === undefined) return unparsableOf("choices[0].message.content");
  if (textBytesOf(content) > SUGGESTION_MAX_BYTES) {
    return { suggestions: { forbidden: [] }, dropped: [{ field: "content", reason: "too_long" }] };
  }
  const body = bodyOf(content);
  if (body === undefined) return unparsableOf("content");
  const dropped: Dropped[] = [];
  reportUnknown(body, KNOWN_KEYS, "", dropped);
  const persona = textFieldOf(body, "persona", MAX_PERSONA_CHARS, dropped);
  const narrativeRules = listFieldOf(
    body,
    "narrative_rules",
    { maxChars: MAX_RULE_CHARS, maxItems: MAX_RULES },
    dropped,
  );
  const rhythmStyle = rhythmStyleOf(body, dropped);
  const examples = examplesOf(body, dropped);
  const forbidden =
    listFieldOf(
      body,
      "forbidden",
      { maxChars: MAX_RULE_CHARS, maxItems: MAX_APPENDED_FORBIDDEN },
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
  return { suggestions, dropped };
};
