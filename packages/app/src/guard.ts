// 这层管：运行时形状守卫。`JSON.parse` 的结果是 `unknown`，先过这里再进逻辑；
// 不用 `Reflect`、不用 `as`——`in` 收窄与数组排除已经够用（M2.2 裁定 #5）。

export const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const stringOf = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export const numberTextOf = (value: unknown): string | undefined =>
  typeof value === "number" || typeof value === "string" ? String(value) : undefined;
