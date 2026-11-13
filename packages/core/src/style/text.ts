// 这层管：任意抛出物的可读文本（未知类型兜底成字符串）；不含业务规则。

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
