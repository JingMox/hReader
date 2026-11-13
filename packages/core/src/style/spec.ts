// 这层管：`style.yaml` → `StyleSpec`（严格模式：任何层级未知键都报，报文按层列合法键）；不碰 IO。

import { parseDocument } from "yaml";

import { HrError } from "../hr-error";
import type { ExampleSpec, LanguageSpec, SentenceRhythmSpec, StyleSpec } from "./contracts";

/** 裁定 #5：`sentence_rhythm` 缺省时按"三段一视觉法则"取 3，"不约束"用空串表示。 */
const DEFAULT_MAX_SENTENCES = 3;

const DEFAULT_VISUAL = "atelier-editorial";

const STYLE_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/u;

interface SchemaNode {
  readonly keys?: Readonly<Record<string, SchemaNode>>;
  readonly items?: SchemaNode;
}

const LEAF: SchemaNode = {};

const EXAMPLE_SCHEMA: SchemaNode = { keys: { bad: LEAF, good: LEAF } };

const RHYTHM_SCHEMA: SchemaNode = { keys: { max_paragraph_sentences: LEAF, style: LEAF } };

const VOCABULARY_SCHEMA: SchemaNode = { keys: { forbidden: LEAF, recommended: LEAF } };

const LANGUAGE_SCHEMA: SchemaNode = {
  keys: {
    persona: LEAF,
    narrative_rules: LEAF,
    sentence_rhythm: RHYTHM_SCHEMA,
    vocabulary: VOCABULARY_SCHEMA,
    examples: { items: EXAMPLE_SCHEMA },
  },
};

const STYLE_SCHEMA: SchemaNode = {
  keys: {
    id: LEAF,
    name: LEAF,
    description: LEAF,
    inherits_visual: LEAF,
    language_style: LANGUAGE_SCHEMA,
  },
};

const invalid = (at: string, detail: string): HrError =>
  new HrError("invalid_style", `${at}：${detail}`);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isList = (value: unknown): value is readonly unknown[] => Array.isArray(value);

interface Positioned {
  readonly message: string;
  readonly pos?: readonly number[];
}

/** `pos` 是码元偏移：自己数换行比开 `prettyErrors` 干净（后者会把片段拼进 message）。 */
const lineAt = (text: string, offset: number): number =>
  (text.slice(0, offset).match(/\n/gu)?.length ?? 0) + 1;

/** 内部导出仅供边界测试（不进公共面）：yaml 的 `pos` 是可选的，无 `pos` 分支无法由真实输入触发。
 *
 * @internal
 */
export const syntaxErrorOf = (error: Positioned, at: string, text: string): HrError => {
  const offset = error.pos?.[0];
  const where = offset === undefined ? "" : `（第 ${String(lineAt(text, offset))} 行）`;
  return new HrError("invalid_style", `${at}：YAML 语法错${where}：${error.message}`, {
    cause: error,
  });
};

interface UnknownKey {
  readonly path: string;
  /** 它那一层的合法键集：报顶层的键集会把用户带偏（G2 P1-5）。 */
  readonly legal: string;
}

const collectUnknown = (
  value: unknown,
  at: string,
  schema: SchemaNode,
  unknown: UnknownKey[],
): void => {
  const { keys, items } = schema;
  if (keys !== undefined && isRecord(value)) {
    const legal = Object.keys(keys).join("、");
    for (const [key, child] of Object.entries(value)) {
      const childSchema = keys[key];
      if (childSchema === undefined) {
        unknown.push({ path: `${at}.${key}`, legal });
        continue;
      }
      collectUnknown(child, `${at}.${key}`, childSchema, unknown);
    }
    return;
  }
  if (items !== undefined && isList(value)) {
    value.forEach((item, index) => {
      collectUnknown(item, `${at}[${String(index)}]`, items, unknown);
    });
  }
};

/** 一次列全所有层级的未知键：用户改键名时不该被"修一个报一个"来回折腾。 */
const assertKnownKeys = (value: unknown, at: string, schema: SchemaNode): void => {
  const unknown: UnknownKey[] = [];
  collectUnknown(value, at, schema, unknown);
  if (unknown.length === 0) return;
  const listed = unknown.map((one) => `${one.path}（这一层的合法键：${one.legal}）`).join("、");
  throw invalid(at, `未知键 ${listed}`);
};

const recordOf = (value: unknown, at: string): Readonly<Record<string, unknown>> => {
  if (!isRecord(value)) throw invalid(at, "必须是映射（YAML 的 key: value 结构）");
  return value;
};

/** 整块可省略（裁定 #5）：`sentence_rhythm:`（空值）与不写它等价，都走内置缺省。 */
const mappingAt = (
  mapping: Readonly<Record<string, unknown>>,
  key: string,
  at: string,
): Readonly<Record<string, unknown>> => recordOf(mapping[key] ?? {}, `${at}.${key}`);

const nonEmpty = (value: unknown, at: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalid(at, "必须是非空字符串");
  }
  return value;
};

const textOf = (mapping: Readonly<Record<string, unknown>>, key: string, at: string): string =>
  nonEmpty(mapping[key], `${at}.${key}`);

/** `style: ''` 是裁定 #5 的"不约束"哨兵：显式空串合法，只拒非字符串。 */
const scalarAt = (
  mapping: Readonly<Record<string, unknown>>,
  key: string,
  at: string,
  fallback: string,
): string => {
  const value = mapping[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw invalid(`${at}.${key}`, "必须是字符串");
  return value;
};

const idOf = (value: unknown, at: string): string => {
  const id = nonEmpty(value, at);
  if (!STYLE_ID.test(id)) {
    throw invalid(at, `id 必须匹配 ${STYLE_ID.source}（禁止 / 与 ..：会逃出风格目录）`);
  }
  return id;
};

/** `{单值 | 列表}` 都收；`[]` 合法（裁定 #5：空列表 = 不约束）。 */
const stringsOf = (
  mapping: Readonly<Record<string, unknown>>,
  key: string,
  at: string,
): readonly string[] => {
  const value = mapping[key];
  if (value === undefined) return [];
  if (typeof value === "string") return [nonEmpty(value, `${at}.${key}`)];
  if (!isList(value)) throw invalid(`${at}.${key}`, "必须是字符串或字符串列表");
  return value.map((item) => nonEmpty(item, `${at}.${key}`));
};

/** 叙事规则是编译产物的骨架，空表只能得到"没有规则"的空壳：这里要求至少一条。 */
const requiredListOf = (
  mapping: Readonly<Record<string, unknown>>,
  key: string,
  at: string,
): readonly string[] => {
  const items = stringsOf(mapping, key, at);
  if (items.length === 0) throw invalid(`${at}.${key}`, "必须至少给一条叙事规则");
  return items;
};

const positiveIntOf = (
  mapping: Readonly<Record<string, unknown>>,
  key: string,
  at: string,
  fallback: number,
): number => {
  const value = mapping[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw invalid(`${at}.${key}`, "必须是正整数");
  }
  return value;
};

const rhythmOf = (mapping: Readonly<Record<string, unknown>>, at: string): SentenceRhythmSpec => ({
  maxParagraphSentences: positiveIntOf(
    mapping,
    "max_paragraph_sentences",
    at,
    DEFAULT_MAX_SENTENCES,
  ),
  style: scalarAt(mapping, "style", at, ""),
});

const vocabularyOf = (mapping: Readonly<Record<string, unknown>>, at: string) => ({
  forbidden: stringsOf(mapping, "forbidden", at),
  recommended: stringsOf(mapping, "recommended", at),
});

const examplesOf = (
  mapping: Readonly<Record<string, unknown>>,
  at: string,
): readonly ExampleSpec[] => {
  const value = mapping["examples"];
  if (value === undefined) return [];
  if (!isList(value)) throw invalid(`${at}.examples`, "必须是映射列表");
  return value.map((item, index) => {
    const itemAt = `${at}.examples[${String(index)}]`;
    const example = recordOf(item, itemAt);
    return { bad: textOf(example, "bad", itemAt), good: textOf(example, "good", itemAt) };
  });
};

const languageOf = (value: unknown, at: string): LanguageSpec => {
  const mapping = recordOf(value, at);
  return {
    persona: textOf(mapping, "persona", at),
    narrativeRules: requiredListOf(mapping, "narrative_rules", at),
    rhythm: rhythmOf(mappingAt(mapping, "sentence_rhythm", at), `${at}.sentence_rhythm`),
    vocabulary: vocabularyOf(mappingAt(mapping, "vocabulary", at), `${at}.vocabulary`),
    examples: examplesOf(mapping, at),
  };
};

/** `parseDocument` 对任意字符串只回填 `errors`、不抛异常：错误路径只有一条。 */
const parseYamlOf = (text: string, at: string): unknown => {
  const document = parseDocument(text, { prettyErrors: false });
  const [first] = document.errors;
  if (first !== undefined) throw syntaxErrorOf(first, at, text);
  const value: unknown = document.toJS({ maxAliasCount: 100 });
  return value;
};

export const parseStyleText = (text: string, at: string): StyleSpec => {
  const value = parseYamlOf(text, at);
  assertKnownKeys(value, at, STYLE_SCHEMA);
  const mapping = recordOf(value, at);
  return {
    id: idOf(mapping["id"], `${at}.id`),
    name: textOf(mapping, "name", at),
    description: textOf(mapping, "description", at),
    inheritsVisual:
      mapping["inherits_visual"] === undefined
        ? DEFAULT_VISUAL
        : idOf(mapping["inherits_visual"], `${at}.inherits_visual`),
    language: languageOf(mapping["language_style"], `${at}.language_style`),
  };
};
