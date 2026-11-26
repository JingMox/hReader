// 这层管：请求体的上限常量，以及把 zod 校验失败统一翻成 `invalid_request`；不读 socket。

import { z } from "zod";

import { HrError } from "../hr-error";
import { looseString } from "../schema";

export const MAX_BODY_BYTES = 1_048_576;

/** 缺失、类型不对与空串同一口径：都算"没给"。 */
export const requiredString = z.string().min(1);

/** 类型不对按没给处理（历史宽松口径）。 */
export const optionalString = looseString;

export const integer = z.number().int();

const messageOf = (issue: z.ZodIssue): string => {
  const key = String(issue.path.at(-1));
  if (issue.code === "invalid_enum_value") return `未知 ${key}：${String(issue.received)}`;
  if (
    issue.code === "invalid_type" &&
    (issue.expected === "integer" || issue.expected === "number")
  ) {
    return `字段 \`${key}\` 必须是整数`;
  }
  return `缺少字符串字段 \`${key}\``;
};

/** 只报第一条：与逐字段取值时"遇错即抛"的历史口径一致。 */
export const parseBody = <Out>(
  schema: z.ZodType<Out, z.ZodTypeDef, unknown>,
  body: unknown,
): Out => {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  throw new HrError("invalid_request", parsed.error.issues.slice(0, 1).map(messageOf).join(""));
};
