// 这层管：`style.yaml` → `StyleSpec`（严格模式：任何层级未知键都报，报文按层列合法键）；不碰 IO。

import { parseDocument } from "yaml";
import { z } from "zod";

import { HrError } from "../hr-error";
import type { LanguageSpec, StyleSpec } from "./contracts";
import { foldWord } from "./words";

/** `sentence_rhythm` 缺省时按"三段一视觉法则"取 3，"不约束"用空串表示。 */
const DEFAULT_MAX_SENTENCES = 3;

const DEFAULT_VISUAL = "atelier-editorial";

const STYLE_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/u;

const NON_EMPTY = "必须是非空字符串";
const POSITIVE_INT = "必须是正整数";
const MAPPING = "必须是映射（YAML 的 key: value 结构）";

/**
 * 严格映射：多余的键由 zod 的 `unrecognized_keys` 报出。issue 的 `message` 借来携带这一层的合法键集，
 * 报文才能提示"它那一层"而不是顶层。
 */
const mapping = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z
    .object(shape, {
      // 对象自己只会报这两种 issue：类型不对，或多出未知键。
      errorMap: (issue) => ({
        message: issue.code === "unrecognized_keys" ? Object.keys(shape).join("、") : MAPPING,
      }),
    })
    .strict();

/** 整块可省略）：`sentence_rhythm:`（空值）与不写它等价，都走内置缺省。 */
const optionalMapping = <Schema extends z.ZodTypeAny>(schema: Schema) =>
  z.preprocess((value) => value ?? {}, schema);

const nonEmptyText = z
  .string({ invalid_type_error: NON_EMPTY, required_error: NON_EMPTY })
  .refine((value) => value.trim().length > 0, NON_EMPTY);

/** id 会拼进磁盘路径，所以只放行 kebab-case：禁止 `/` 与 `..` 逃出风格目录。 */
const styleId = nonEmptyText.pipe(
  z.string().regex(STYLE_ID, `id 必须匹配 ${STYLE_ID.source}（禁止 / 与 ..：会逃出风格目录）`),
);

/** `{单值 | 列表}` 都收；缺省与 `[]` 合法（空列表 = 不约束）。 */
const stringList = z.preprocess(
  (value) => (value === undefined ? [] : typeof value === "string" ? [value] : value),
  z.array(nonEmptyText, { invalid_type_error: "必须是字符串或字符串列表" }),
);

/** 叙事规则是编译产物的骨架，空表只能得到"没有规则"的空壳：这里要求至少一条。 */
const requiredList = stringList.pipe(z.array(z.string()).min(1, "必须至少给一条叙事规则"));

const rhythmSchema = optionalMapping(
  mapping({
    max_paragraph_sentences: z
      .number({ invalid_type_error: POSITIVE_INT })
      .int(POSITIVE_INT)
      .positive(POSITIVE_INT)
      .default(DEFAULT_MAX_SENTENCES),
    // `style: ''` 是"不约束句式"的哨兵：显式空串合法，只拒非字符串。
    style: z.string({ invalid_type_error: "必须是字符串" }).default(""),
  }),
);

/**
 * 同一禁词写两遍会让 lint 对每处命中报两遍（用户看到的是重复项，不是加强警告）。
 * 与匹配同口径：折叠后去重保序，落盘值取 NFC——`e` + 组合重音与 `é` 是同一个词。
 */
const uniqueWordsOf = (words: readonly string[]): readonly string[] => {
  const seen = new Set<string>();
  return words
    .map((word) => word.normalize("NFC"))
    .filter((word) => {
      const folded = foldWord(word);
      const first = !seen.has(folded);
      seen.add(folded);
      return first;
    });
};

const vocabularySchema = optionalMapping(
  mapping({ forbidden: stringList.transform(uniqueWordsOf), recommended: stringList }),
);

const exampleSchema = mapping({ bad: nonEmptyText, good: nonEmptyText });

const languageSchema = mapping({
  persona: nonEmptyText,
  narrative_rules: requiredList,
  sentence_rhythm: rhythmSchema,
  vocabulary: vocabularySchema,
  examples: z.array(exampleSchema, { invalid_type_error: "必须是映射列表" }).default([]),
}).transform((language): LanguageSpec => ({
  persona: language.persona,
  narrativeRules: language.narrative_rules,
  rhythm: {
    maxParagraphSentences: language.sentence_rhythm.max_paragraph_sentences,
    style: language.sentence_rhythm.style,
  },
  vocabulary: language.vocabulary,
  examples: language.examples,
}));

const styleSchema = mapping({
  id: styleId,
  name: nonEmptyText,
  description: nonEmptyText,
  inherits_visual: styleId.default(DEFAULT_VISUAL),
  language_style: languageSchema,
}).transform((spec): StyleSpec => ({
  id: spec.id,
  name: spec.name,
  description: spec.description,
  inheritsVisual: spec.inherits_visual,
  language: spec.language_style,
}));

/** 路径写法与 YAML 一致：键用 `.`，列表项用 `[i]`。 */
const pathText = (path: readonly (string | number)[]): string =>
  path
    .map((segment) => (typeof segment === "number" ? `[${String(segment)}]` : `.${segment}`))
    .join("");

/** 一次列全所有层级的未知键：用户改键名时不该被"修一个报一个"来回折腾；其余错误只报第一条。 */
const failureOf = (error: z.ZodError, at: string): HrError => {
  const messageOf = (issue: z.ZodIssue): string => `${at}${pathText(issue.path)}：${issue.message}`;
  const unknown = error.issues.flatMap((issue) =>
    issue.code === "unrecognized_keys"
      ? issue.keys.map(
          (key) => `${at}${pathText(issue.path)}.${key}（这一层的合法键：${issue.message}）`,
        )
      : [],
  );
  if (unknown.length > 0) {
    return new HrError("invalid_style", `${at}：未知键 ${unknown.join("、")}`);
  }
  return new HrError("invalid_style", error.issues.slice(0, 1).map(messageOf).join(""));
};

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

/** `parseDocument` 对任意字符串只回填 `errors`、不抛异常：错误路径只有一条。 */
const parseYamlOf = (text: string, at: string): unknown => {
  const document = parseDocument(text, { prettyErrors: false });
  const [first] = document.errors;
  if (first !== undefined) throw syntaxErrorOf(first, at, text);
  const value: unknown = document.toJS({ maxAliasCount: 100 });
  return value;
};

export const parseStyleText = (text: string, at: string): StyleSpec => {
  const parsed = styleSchema.safeParse(parseYamlOf(text, at));
  if (!parsed.success) throw failureOf(parsed.error, at);
  return parsed.data;
};
