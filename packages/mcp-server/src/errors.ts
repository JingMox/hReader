// 这层管：工具结果的两副面孔（成功 = 文本载荷 + 可选 MCP-UI 元数据；失败 = `isError` 工具结果）。
// 失败绝不抛给 SDK 层：`HrError.code` 进正文，堆栈进 stderr（AC-3）。

import { HrError } from "@hreader/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { logFailure, messageOf } from "./log";

const asJson = (value: unknown): string => JSON.stringify(value, null, 2);

interface UiMeta {
  readonly ui: { readonly resourceUri: string };
}

export const okResult = (value: unknown, meta?: UiMeta): CallToolResult => {
  const content: CallToolResult["content"] = [{ type: "text", text: asJson(value) }];
  return meta === undefined ? { content } : { content, _meta: { ui: meta.ui } };
};

const codeOf = (error: unknown): string => (error instanceof HrError ? error.code : "internal");

export const failureOf = (tool: string, error: unknown): CallToolResult => {
  logFailure(tool, error);
  return {
    isError: true,
    content: [{ type: "text", text: `[${codeOf(error)}] ${messageOf(error)}` }],
  };
};

/** 每个工具的唯一出口：任何 reject 都折成工具错误，禁止穿透成进程级异常。 */
export const guarded = (
  tool: string,
  body: () => Promise<CallToolResult>,
): Promise<CallToolResult> => body().catch((error: unknown) => failureOf(tool, error));
