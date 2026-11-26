// 这层管：工具结果的两副面孔（成功 = 文本载荷 + 可选 MCP-UI 元数据；失败 = `isError` 工具结果）。
// 失败绝不抛给 SDK 层：`HrError.code` 进正文，堆栈进 stderr。

import { realpathSync } from "node:fs";

import { HrError } from "@hreader/core";
import { McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { logFailure } from "./log";

const asJson = (value: unknown): string => JSON.stringify(value, null, 2);

interface UiMeta {
  readonly ui: { readonly resourceUri: string };
}

export const okResult = (value: unknown, meta?: UiMeta): CallToolResult => {
  const content: CallToolResult["content"] = [{ type: "text", text: asJson(value) }];
  return meta === undefined ? { content } : { content, _meta: { ui: meta.ui } };
};

/**
 * Node errno 的**兜底**映射：主修在调用点（那里才知道"哪个文件的哪次操作"），这里只防"将来有人漏包"。
 * `ENOENT`/`EISDIR`/`ENAMETOOLONG` 是"参数指错了"，`internal` 只留给真正没料到的错误。
 */
const ERRNO_CODES: Readonly<Record<string, string>> = {
  ENOENT: "not_found",
  EISDIR: "not_a_file",
  ENAMETOOLONG: "invalid_input",
  ENOTDIR: "io_failure",
  EACCES: "io_failure",
  EPERM: "io_failure",
  ENOSPC: "io_failure",
  EMFILE: "io_failure",
  EEXIST: "io_failure",
  EIO: "io_failure",
};

/** 有 `syscall` 才是 fs 层错误：只有它才配被兜底成 `io_failure`，其余（`TypeError` 等）仍是 `internal`。 */
const errnoCodeOf = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const errno: unknown = error.code;
  if (typeof errno !== "string") return undefined;
  const mapped = ERRNO_CODES[errno];
  if (mapped !== undefined) return mapped;
  return "syscall" in error ? "io_failure" : undefined;
};

const codeOf = (error: unknown): string =>
  error instanceof HrError ? error.code : (errnoCodeOf(error) ?? "internal");

/** 兜底的"人话"：errno 原文与绝对路径都不进正文——前者泄宿主布局、后者模型无法据此行动。 */
const GENERIC_MESSAGES: Readonly<Record<string, string>> = {
  not_found: "目标不存在",
  not_a_file: "目标不是普通文件",
  invalid_input: "参数不合法",
  io_failure: "文件操作失败（细节见服务器日志）",
};

/** 折叠用的根：`cwd` + 它的 `realpath`（只差一个就只留一个）。两个都折是为了将来 cwd 经
 * 符号链接 / bind mount 进来时，core 报的 realpath 路径也能折到。
 * `realpath` 可注入：它只是"锦上添花"的第二个根，失败了就用 `cwd`——折叠逻辑绝不能把请求搞挂。 */
export const rootsOf = (
  cwd: string,
  realpath: (path: string) => string = realpathSync,
): readonly string[] => {
  try {
    const real = realpath(cwd);
    return real === cwd ? [cwd] : [cwd, real];
  } catch {
    return [cwd];
  }
};

/** 把匹配的根**连同后面的分隔符**一起吃掉：否则折完会剩一个前导 `/`（`a.html` → `/a.html`）。
 * 要求根后面必须跟分隔符或行尾，所以 `root=/ws/hReader` 不会误伤 `/ws/hReader-something`。
 * `root === "/"` 直接跳过：那时根就是每个绝对路径的前缀，折它只会把文案拆坏。
 * 长的根先折：`cwd` 与 `realpath(cwd)` 互相包含时（macOS `/var/…` → `/private/var/…`），
 * 先折短的会命中另一串的中段，折出 `/privatedoc.html` 这种畸形。 */
export const elidedOf = (message: string, roots: readonly string[]): string =>
  [...roots]
    .sort((left, right) => right.length - left.length)
    .reduce((text, root) => {
      if (root === "/") return text;
      const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return text.replace(new RegExp(`${escaped}(?:[/\\\\]|$)`, "g"), "");
    }, message);

/**
 * 把 core/依赖层漏出来的绝对路径折掉。**只用在"文案不是我们写的"那几处**（core 的 ops、风格解析、
 * 资源读取）：用户传给我们的 `filePath` 必须原样回显，所以这里不能退化成 `humanMessageOf`
 * 里的全局兜底——那会把 `/ws/a.html` 折成 `a.html`，等于回显一条宿主没发过的路径。
 */
export const foldedOf = (error: unknown): unknown =>
  error instanceof HrError
    ? new HrError(error.code, elidedOf(error.message, rootsOf(process.cwd())), {
        cause: error,
      })
    : error;

const humanMessageOf = (error: unknown): string =>
  error instanceof HrError ? error.message : (GENERIC_MESSAGES[codeOf(error)] ?? "服务器内部错误");

/**
 * JSON-RPC 层的分流：错误码是宿主的控制流开关，`data.code` 必须一直带着（宿主按它细分）。
 * `-32002 Resource not found` 是 MCP 规范里的码，但 SDK 1.32.2 的 `ErrorCode` 枚举里**没有**它，所以写数字。
 */
const RPC_RESOURCE_NOT_FOUND = -32002;
const RPC_INVALID_PARAMS = -32602;
const RPC_INTERNAL = -32603;

export const rpcCodeOf = (code: string): number => {
  if (code === "not_found" || code === "unknown_style") return RPC_RESOURCE_NOT_FOUND;
  // `path_outside_workspace` 是"对同一个工具换条参数就对了"：参数不合法，不是服务器故障。
  if (code === "invalid_input" || code === "path_outside_workspace") return RPC_INVALID_PARAMS;
  return RPC_INTERNAL;
};

/** `resources/read` 的失败要走 JSON-RPC error：code 与工具出口同源，`data.code` 保留细码。 */
export const rpcErrorOf = (error: unknown): McpError => {
  const code = codeOf(error);
  return new McpError(rpcCodeOf(code), humanMessageOf(error), { code });
};

export const failureOf = (tool: string, error: unknown): CallToolResult => {
  logFailure(tool, error);
  return {
    isError: true,
    content: [{ type: "text", text: `[${codeOf(error)}] ${humanMessageOf(error)}` }],
  };
};

/** 每个工具的唯一出口：任何 reject 都折成工具错误，禁止穿透成进程级异常。 */
export const guarded = (
  tool: string,
  body: () => Promise<CallToolResult>,
): Promise<CallToolResult> => body().catch((error: unknown) => failureOf(tool, error));
