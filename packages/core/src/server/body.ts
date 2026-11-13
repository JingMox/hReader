// 这层管：请求体的上限常量、JSON 对象解析与字段取值（缺失即 `invalid_request`）；不读 socket。

import { HrError } from "../hr-error";

export const MAX_BODY_BYTES = 1_048_576;

type JsonBody =
  { readonly ok: true; readonly value: Readonly<Record<string, unknown>> } | { readonly ok: false };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const jsonBodyOf = (text: string): JsonBody => {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? { ok: true, value } : { ok: false };
  } catch {
    return { ok: false };
  }
};

export const stringFieldOf = (
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};

export const numberFieldOf = (
  record: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

export const integerFieldOf = (record: Readonly<Record<string, unknown>>, key: string): number => {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new HrError("invalid_request", `字段 \`${key}\` 必须是整数`);
  }
  return value;
};

export const requiredStringOf = (
  record: Readonly<Record<string, unknown>>,
  key: string,
): string => {
  const value = stringFieldOf(record, key);
  if (value === undefined || value.length === 0) {
    throw new HrError("invalid_request", `缺少字符串字段 \`${key}\``);
  }
  return value;
};
