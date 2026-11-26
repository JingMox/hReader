// This layer: the two faces of a tool result (success = text payload + optional MCP-UI metadata; failure = `isError` tool result).
// Failures are never thrown to the SDK layer: `HrError.code` goes into the body, the stack goes to stderr.

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
 * Fallback mapping for Node errnos: the real translation lives at the call sites (only they know "which file, which operation"); this only guards against a caller forgetting to wrap.
 * `ENOENT`/`EISDIR`/`ENAMETOOLONG` mean "the argument pointed at the wrong thing"; `internal` is reserved for genuinely unexpected errors.
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

/** Only an error with `syscall` is an fs-layer error: only it earns the `io_failure` fallback; everything else (`TypeError` etc.) stays `internal`. */
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

/** The fallback "human words": neither the raw errno nor the absolute path enters the body — the former leaks host layout, the latter gives the model nothing to act on. */
const GENERIC_MESSAGES: Readonly<Record<string, string>> = {
  not_found: "目标不存在",
  not_a_file: "目标不是普通文件",
  invalid_input: "参数不合法",
  io_failure: "文件操作失败（细节见服务器日志）",
};

/** Roots to fold: `cwd` + its `realpath` (if they differ, keep both). Both are folded so that when cwd enters through a
 * symlink / bind mount, the realpath that core reports also folds.
 * `realpath` is injectable: it is only a best-effort second root — on failure we use `cwd`; folding must never break the request. */
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

/** Consume the matching root **together with the separator after it**: otherwise the folded text keeps a leading `/` (`a.html` → `/a.html`).
 * The root must be followed by a separator or end of text, so `root=/ws/hReader` does not corrupt `/ws/hReader-something`.
 * `root === "/"` is skipped outright: there the root is a prefix of every absolute path, and folding it would only mangle the message.
 * Longer roots fold first: when `cwd` and `realpath(cwd)` contain each other (macOS `/var/…` → `/private/var/…`),
 * folding the shorter one first hits the middle of the longer string and produces malformed text like `/privatedoc.html`. */
export const elidedOf = (message: string, roots: readonly string[]): string =>
  [...roots]
    .sort((left, right) => right.length - left.length)
    .reduce((text, root) => {
      if (root === "/") return text;
      const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return text.replace(new RegExp(`${escaped}(?:[/\\\\]|$)`, "g"), "");
    }, message);

/**
 * Fold absolute paths that leak out of core/dependency layers. **Only used at the spots where the wording is not ours** (core ops, style resolution,
 * resource reads): the `filePath` the user gave us must echo back verbatim, so this must not degrade into a global fallback inside
 * `humanMessageOf` — that would fold `/ws/a.html` into `a.html`, echoing a path the host never sent.
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
 * JSON-RPC-level routing: the error code is the host's control-flow switch, and `data.code` must always ride along (the host subdivides on it).
 * `-32002 Resource not found` is a code from the MCP spec, but the `ErrorCode` enum of SDK 1.32.2 does **not** include it, hence the literal number.
 */
const RPC_RESOURCE_NOT_FOUND = -32002;
const RPC_INVALID_PARAMS = -32602;
const RPC_INTERNAL = -32603;

export const rpcCodeOf = (code: string): number => {
  if (code === "not_found" || code === "unknown_style") return RPC_RESOURCE_NOT_FOUND;
  // `path_outside_workspace` means "same tool, different arguments would work": the argument is invalid, not a server fault.
  if (code === "invalid_input" || code === "path_outside_workspace") return RPC_INVALID_PARAMS;
  return RPC_INTERNAL;
};

/** `resources/read` failures go through a JSON-RPC error: the code shares the same source as the tool exit, and `data.code` keeps the fine code. */
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

/** The single exit for every tool: any rejection folds into a tool error and must never escape as a process-level exception. */
export const guarded = (
  tool: string,
  body: () => Promise<CallToolResult>,
): Promise<CallToolResult> => body().catch((error: unknown) => failureOf(tool, error));
