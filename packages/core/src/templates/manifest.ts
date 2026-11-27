// This layer: `template.json` → `TemplateManifest`（严格模式：未知键报错并列出本层合法键，
// 与 `style/spec.ts` 同口径）；只校验形状与值域，不判目录名一致性、不碰 IO。

import { z } from "zod";

import { HrError } from "../hr-error";
import { TEMPLATE_ID, type TemplateManifest } from "./contracts";

const NON_EMPTY = "必须是非空字符串";
const MAPPING = "必须是对象（JSON 的 { key: value } 结构）";

/** 严格映射：多余键由 zod 的 `unrecognized_keys` 报出，issue 的 message 借来携带本层合法键集。 */
const mapping = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z
    .object(shape, {
      errorMap: (issue) => ({
        message: issue.code === "unrecognized_keys" ? Object.keys(shape).join("、") : MAPPING,
      }),
    })
    .strict();

const nonEmptyText = z
  .string({ invalid_type_error: NON_EMPTY, required_error: NON_EMPTY })
  .refine((value) => value.trim().length > 0, NON_EMPTY);

/** id 会拼进磁盘路径：kebab-case 之外（`..`/`/`/`\`/NUL/大写/超长）一律拒绝。 */
const templateId = nonEmptyText.pipe(
  z.string().regex(TEMPLATE_ID, `id 必须匹配 ${TEMPLATE_ID.source}（kebab-case，禁止路径字符）`),
);

/**
 * 成员相对路径（entry/style/guide）：只允许普通文件名与 `/` 分隔的子路径；
 * `..`、`.`、空段、反斜杠、NUL、绝对路径一律拒绝——这是词法闸，符号链接逃逸另由 realpath 复核。
 */
const memberPath = nonEmptyText.pipe(
  z
    .string()
    .refine(
      (value) =>
        !value.includes("\0") &&
        !value.includes("\\") &&
        !value.startsWith("/") &&
        value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
      "成员路径必须是模板目录内的相对路径（禁止 ..、.、反斜杠、空段、NUL、绝对路径）",
    ),
);

const manifestSchema = mapping({
  id: templateId,
  name: nonEmptyText,
  description: nonEmptyText,
  version: z.literal(1, { invalid_type_error: "version 必须是数字 1" }),
  format: z.enum(["html", "managed"], { invalid_type_error: 'format 必须是 "html" 或 "managed"' }),
  entry: memberPath.optional(),
  style: memberPath.optional(),
  guide: memberPath.optional(),
  tags: z.array(nonEmptyText, { invalid_type_error: "tags 必须是字符串数组" }).default([]),
});

/** 路径写法与 JSON 指针一致：键用 `.`，列表项用 `[i]`。 */
const pathText = (path: readonly (string | number)[]): string =>
  path
    .map((segment) => (typeof segment === "number" ? `[${String(segment)}]` : `.${segment}`))
    .join("");

/** 一次列全所有未知键（含 `__proto__`/`constructor` 这类污染键——zod 严格模式天然拒绝它们）；其余错误只报第一条。 */
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
    return new HrError("invalid_template", `${at}：未知键 ${unknown.join("、")}`);
  }
  return new HrError("invalid_template", error.issues.slice(0, 1).map(messageOf).join(""));
};

/** 只负责"文本 → 校验过的 manifest"；JSON 语法错与形状错都落成 `invalid_template`。 */
export const parseManifestText = (text: string, at: string): TemplateManifest => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error: unknown) {
    throw new HrError("invalid_template", `${at}：不是合法 JSON`, { cause: error });
  }
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) throw failureOf(parsed.error, at);
  const { entry, style, guide } = parsed.data;
  return {
    id: parsed.data.id,
    name: parsed.data.name,
    description: parsed.data.description,
    version: parsed.data.version,
    format: parsed.data.format,
    tags: parsed.data.tags,
    ...(entry === undefined ? {} : { entry }),
    ...(style === undefined ? {} : { style }),
    ...(guide === undefined ? {} : { guide }),
  };
};
