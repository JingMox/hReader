// 这层管：CDP 报文的纯构造/解析（请求、reply/事件/错误三分类、错误首行截断）；零 I/O，不认识 WebSocket 与进程。

export type CdpParams = Readonly<Record<string, unknown>>;

type CdpReply =
  | { readonly kind: "reply"; readonly id: number; readonly result: CdpParams }
  | { readonly kind: "event"; readonly method: string; readonly params: CdpParams }
  | { readonly kind: "error"; readonly id: number; readonly message: string }
  | { readonly kind: "invalid" };

const INVALID: CdpReply = { kind: "invalid" };

const isRecord = (value: unknown): value is CdpParams =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 解析后的字段取值：不要 `as`，也不要 `any` 在层间流动。 */
export const fieldOf = (value: unknown, key: string): unknown => Reflect.get(Object(value), key);

const recordOrEmptyOf = (value: unknown): CdpParams => (isRecord(value) ? value : {});

/** 数组字段的取值：`Array.isArray` 会缩窄成 `any[]`，这里立刻摊成 `unknown[]`，别让 `any` 流出去。 */
export const listOf = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value.map((item: unknown) => item) : [];

/**
 * 只留首个非空行并截到 200 字：Chrome 的报错常带整段栈与绝对路径，
 * 整段塞进 envelope 既泄路径又撑爆 `--json`（D2）。
 */
export const firstErrorLineOf = (text: string): string => {
  const line = text.split(/\r?\n/u).find((item) => item.trim() !== "") ?? "";
  return line.length > 200 ? line.slice(0, 200) : line;
};

/** `sessionId` 必须挂在报文顶层（`flatten:true` 的约定），塞进 `params` 会被浏览器当成未知参数。 */
export const cdpCallOf = (
  id: number,
  method: string,
  params: CdpParams,
  sessionId?: string,
): string =>
  sessionId === undefined
    ? JSON.stringify({ id, method, params })
    : JSON.stringify({ id, method, params, sessionId });

const errorMessageOf = (error: unknown): string => {
  if (!isRecord(error)) return "未知的 CDP 错误";
  const message = error["message"];
  return typeof message === "string" ? firstErrorLineOf(message) : "未知的 CDP 错误";
};

export const replyOf = (raw: string): CdpReply => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return INVALID;
  }
  if (!isRecord(parsed)) return INVALID;
  const id = parsed["id"];
  if (typeof id === "number") {
    return parsed["error"] === undefined
      ? { kind: "reply", id, result: recordOrEmptyOf(parsed["result"]) }
      : { kind: "error", id, message: errorMessageOf(parsed["error"]) };
  }
  const method = parsed["method"];
  if (typeof method !== "string") return INVALID;
  return { kind: "event", method, params: recordOrEmptyOf(parsed["params"]) };
};
