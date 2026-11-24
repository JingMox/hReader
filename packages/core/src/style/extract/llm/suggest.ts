// 这层管：模型响应文本 → `Suggestions`（逐字段校验、有据丢弃、永不抛）+ "能不能用"的判据；不合并。

import { z } from "zod";

import { jsonArray, jsonObject } from "../../../schema";
import type { ExampleSpec } from "../../contracts";

/** 卡 §4 的字数上限：超限整条丢弃而不是截断——半截人格比没有人格更坏。 */
const MAX_PERSONA_CHARS = 200;
const MAX_RULE_CHARS = 120;
const MAX_RULES = 6;
const MAX_EXAMPLES = 2;

/** 单次响应最多收 24 条 `forbidden` 候选（候选上限，不是产物总额）；合并阶段与统计层共享 `MAX_FORBIDDEN=24`
 * 总额（统计层 k 条时实得 `24-k`），溢出聚合记一条 `too_long`。 */
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

const KNOWN_RHYTHM_KEYS: readonly string[] = ["style"]; // max_paragraph_sentences 归统计层（D3），出现即 not_owned

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

/** 只认 OpenAI 兼容形状的 `choices[0].message.content`；`choices` 里多出来的项不读。 */
const completionSchema = z.object({
  choices: z.tuple([z.object({ message: z.object({ content: z.string() }) })]).rest(z.unknown()),
});

/** 建议文本统一规格：先 trim 再判空与长度；空串与类型不对同属 `wrong_type`，超长才是 `too_long`。 */
const trimmedText = z.string().trim().min(1);

const textSchema = (maxChars: number) => trimmedText.max(maxChars);

const exampleSchema = z.object({ bad: trimmedText, good: trimmedText });

/** 失败的原因只有两种：太长，或者"不是可用的文本"（类型错 / 空白）。 */
const reasonOf = (error: z.ZodError): DroppedReason =>
  error.issues.some((issue) => issue.code === "too_big") ? "too_long" : "wrong_type";

/**
 * 真实模型常把 JSON 包在 ``` / ```json 围栏里，BOM 也见过：解析前剥掉，剥完仍非法才算不可解析
 * ——否则 F3 会把这种常见写法报成 `llm_failure`（假故障）。
 */
const tryJson = (text: string): unknown => {
  const stripped = text.trim().replace(/^\uFEFF/, "");
  const fence = /^```[A-Za-z]*[ \t]*\r?\n([\s\S]*?)\r?\n```$/.exec(stripped);
  try {
    return JSON.parse((fence?.[1] ?? stripped).replace(/^\uFEFF/, ""));
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

/** 任何一层不是期望的形状都归到"整份不可解析"。 */
const contentTextOf = (raw: string): string | undefined => {
  const completion = completionSchema.safeParse(tryJson(raw));
  return completion.success ? completion.data.choices[0].message.content : undefined;
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

/** `field` 是进 `dropped` 的字段名：子对象里的键要带上前缀（`rhythm.style`）；列表字段同样只认它。 */
interface FieldSpec {
  readonly key: string;
  readonly field: string;
  readonly maxChars: number;
}

/** 单值文本字段：类型错 → `wrong_type`，超长 → `too_long`，都不抛。 */
const textFieldOf = (
  body: Readonly<Record<string, unknown>>,
  spec: FieldSpec,
  dropped: Dropped[],
): string | undefined => {
  const value = body[spec.key];
  if (value === undefined) return undefined;
  const text = textSchema(spec.maxChars).safeParse(value);
  if (text.success) return text.data;
  dropped.push({ field: spec.field, reason: reasonOf(text.error) });
  return undefined;
};

/**
 * 逐项筛字符串列表：坏项按 `name[index]` 记一条并跳过，不因一项坏掉丢掉整个字段。
 * 数组项只能是字符串或非字符串（后者即 `wrong_type`），没有"叶子里还藏键"的形态。
 */
const itemsOf = (
  value: readonly unknown[],
  field: string,
  maxChars: number,
  dropped: Dropped[],
): readonly string[] => {
  const items: string[] = [];
  value.forEach((item, index) => {
    const text = textSchema(maxChars).safeParse(item);
    if (text.success) {
      items.push(text.data);
    } else {
      dropped.push({ field: `${field}[${String(index)}]`, reason: reasonOf(text.error) });
    }
  });
  return items;
};

const listFieldOf = (
  body: Readonly<Record<string, unknown>>,
  spec: FieldSpec,
  maxItems: number,
  dropped: Dropped[],
): readonly string[] | undefined => {
  const value = body[spec.key];
  if (value === undefined) return undefined;
  const list = jsonArray.safeParse(value);
  if (!list.success) {
    dropped.push({ field: spec.field, reason: "wrong_type" });
    return undefined;
  }
  const items = itemsOf(list.data, spec.field, spec.maxChars, dropped);
  if (items.length <= maxItems) return items;
  dropped.push({ field: spec.field, reason: "too_long" });
  return items.slice(0, maxItems);
};

const pairOf = (item: unknown, at: string, dropped: Dropped[]): ExampleSpec | undefined => {
  const record = jsonObject.safeParse(item);
  if (!record.success) {
    dropped.push({ field: at, reason: "wrong_type" });
    return undefined;
  }
  if (Object.keys(record.data).some((key) => !Object.hasOwn(exampleSchema.shape, key))) {
    dropped.push({ field: at, reason: "not_owned" });
  }
  const pair = exampleSchema.safeParse(record.data);
  if (!pair.success) {
    dropped.push({ field: at, reason: "wrong_type" });
    return undefined;
  }
  return pair.data;
};

const examplesOf = (
  body: Readonly<Record<string, unknown>>,
  dropped: Dropped[],
): readonly ExampleSpec[] | undefined => {
  const value = body["examples"];
  if (value === undefined) return undefined;
  const list = jsonArray.safeParse(value);
  if (!list.success) {
    dropped.push({ field: "examples", reason: "wrong_type" });
    return undefined;
  }
  const examples = list.data
    .map((item, index) => pairOf(item, `examples[${String(index)}]`, dropped))
    .filter((example): example is ExampleSpec => example !== undefined);
  if (examples.length <= MAX_EXAMPLES) return examples;
  dropped.push({ field: "examples", reason: "too_long" });
  return examples.slice(0, MAX_EXAMPLES);
};

/**
 * 节奏描述：扁平的 `rhythm_style` 是 prompt 要的键，**也是权威**——它可用时 `rhythm` 对象整体记 `not_owned`
 * 后不再解析；扁平键**缺席或不可用时都**用 `rhythm.style` 兜底，其中 `max_paragraph_sentences` 归统计层（D3）。
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
  const rhythmRecord = jsonObject.safeParse(rhythm);
  if (!rhythmRecord.success) {
    dropped.push({ field: "rhythm", reason: "wrong_type" });
    return undefined;
  }
  reportUnknown(rhythmRecord.data, KNOWN_RHYTHM_KEYS, "rhythm.", dropped);
  return textFieldOf(
    rhythmRecord.data,
    { key: "style", field: "rhythm.style", maxChars: MAX_RULE_CHARS },
    dropped,
  );
};

const nonBlankOf = (text: string | undefined): boolean => (text ?? "").trim().length > 0;
/**
 * "这份建议能不能用"（AC-3②，B 案判据）：四个"模型才有"的字段里有任意一个非空白即可用；
 * 整份不可解析时它们必然全空，故不必另看 `dropped`，`forbidden` 只是追加项也不参与判断。
 * 本谓词对外导出，调用方可能传没 trim 过的对象，所以 trim 在这里做，不假设入参已规范化。
 */
export const llmUsableOf = (suggestions: Suggestions): boolean =>
  nonBlankOf(suggestions.persona) ||
  (suggestions.narrativeRules ?? []).some(nonBlankOf) ||
  nonBlankOf(suggestions.rhythmStyle) ||
  (suggestions.examples ?? []).length > 0;

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
    { key: "narrative_rules", field: "narrative_rules", maxChars: MAX_RULE_CHARS },
    MAX_RULES,
    dropped,
  );
  const rhythmStyle = rhythmStyleOf(body, dropped);
  const examples = examplesOf(body, dropped);
  const forbidden =
    listFieldOf(
      body,
      { key: "forbidden", field: "forbidden", maxChars: MAX_RULE_CHARS },
      MAX_APPENDED_FORBIDDEN,
      dropped,
    ) ?? [];
  // `exactOptionalPropertyTypes`：缺省必须是"键不存在"，不能是"键为 undefined"。
  return {
    forbidden,
    ...(persona === undefined ? {} : { persona }),
    ...(narrativeRules === undefined ? {} : { narrativeRules }),
    ...(rhythmStyle === undefined ? {} : { rhythmStyle }),
    ...(examples === undefined ? {} : { examples }),
  };
};

/**
 * 模型响应 → 建议。**永不抛**：坏 JSON、形状不对、超长都退化成空建议 + `dropped`；是否可用由
 * `llmUsableOf` 判定，本函数不造第二套校验。
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
  const body = jsonObject.safeParse(tryJson(content));
  if (!body.success) return unparsableOf("content");
  const dropped: Dropped[] = [];

  return { suggestions: fieldsOf(body.data, dropped), dropped };
};
