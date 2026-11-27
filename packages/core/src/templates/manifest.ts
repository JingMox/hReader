// This layer: `template.json` → `TemplateManifest` (strict mode: unknown keys are rejected
// with the layer's legal keys listed, same contract as `style/spec.ts`); validates shape and
// value domains only — no dir-name consistency checks, no IO.

import { z } from "zod";

import { HrError } from "../hr-error";
import { TEMPLATE_ID, type TemplateManifest } from "./contracts";

const NON_EMPTY = "必须是非空字符串";
const MAPPING = "必须是对象（JSON 的 { key: value } 结构）";

/** Strict mapping: extra keys surface as zod `unrecognized_keys`; the issue's message is borrowed to carry this layer's legal key set. */
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

/** The id is joined into disk paths: anything outside kebab-case (`..`/`/`/`\`/NUL/uppercase/overlength) is rejected. */
const templateId = nonEmptyText.pipe(
  z.string().regex(TEMPLATE_ID, `id 必须匹配 ${TEMPLATE_ID.source}（kebab-case，禁止路径字符）`),
);

/**
 * Member relative paths (entry/style/guide): only plain filenames and `/`-separated subpaths;
 * `..`, `.`, empty segments, backslashes, NUL and absolute paths are all rejected — this is the
 * lexical gate; symlink escape is checked separately via realpath.
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

/** Path notation matches JSON-pointer style: `.key` for object keys, `[i]` for array items. */
const pathText = (path: readonly (string | number)[]): string =>
  path
    .map((segment) => (typeof segment === "number" ? `[${String(segment)}]` : `.${segment}`))
    .join("");

/** All unknown keys are listed in one go (including pollution keys like `__proto__`/`constructor`, which strict mode rejects by construction); other errors report only the first. */
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

/** "text → validated manifest" only; both JSON syntax errors and shape errors land as `invalid_template`. */
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
