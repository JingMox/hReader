// 这层管：MCP stdio 客户端（换行 JSON-RPC：initialize → notifications/initialized → tools/call）。
// 不引 SDK：测试要验的恰是"真二进制说真协议"，SDK 客户端会把协议细节藏掉。

import { assert, parseJson } from "./check.ts";
import type { JsonObject } from "./cli.ts";
import { MCP_BIN } from "./env.ts";
import { live, stopProc, type LiveProc } from "./proc.ts";

export interface McpClient {
  readonly proc: LiveProc;
  /** `tools/call` 的便捷封装：返回 `{isError, text}`（text = 首个 text content）。 */
  readonly call: (tool: string, args: JsonObject) => Promise<McpResult>;
  readonly close: () => Promise<number | null>;
}

export interface McpResult {
  readonly isError: boolean;
  readonly text: string;
  readonly raw: JsonObject;
}

interface Pending {
  readonly resolve: (value: JsonObject) => void;
  readonly timer: NodeJS.Timeout;
}

export const startMcp = async (workspace: string): Promise<McpClient> => {
  const proc = live(process.execPath, [MCP_BIN, "--workspace", workspace], {
    cwd: workspace,
    stdin: true,
  });
  let seq = 0;
  const pending = new Map<number, Pending>();
  const send = (message: JsonObject): void => {
    assert(proc.proc.stdin !== null, "MCP stdin 不可用");
    proc.proc.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const request = (method: string, params: JsonObject): Promise<JsonObject> => {
    seq += 1;
    const id = seq;
    return new Promise<JsonObject>((resolve, reject) => {
      pending.set(id, {
        resolve,
        timer: setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP 请求超时：${method}`));
        }, 15_000),
      });
      send({ jsonrpc: "2.0", id, method, params });
    });
  };
  const pump = async (): Promise<void> => {
    for (;;) {
      const line = await proc.nextLine(60_000);
      if (line === undefined) return;
      const trimmed = line.trim();
      if (trimmed === "") continue;
      const parsed = parseJson(trimmed, "MCP stdout 帧");
      if (typeof parsed !== "object" || parsed === null) continue;
      const id: unknown = Reflect.get(parsed, "id");
      if (typeof id !== "number") continue;
      const waiter = pending.get(id);
      if (waiter === undefined) continue;
      pending.delete(id);
      clearTimeout(waiter.timer);
      waiter.resolve(parsed as JsonObject);
    }
  };
  void pump();

  // A failed handshake must reap the spawned mcp-server before rethrowing:
  // an escaping error plus a live process is a leak.
  let init: JsonObject;
  try {
    init = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "hr-integration-test", version: "0.0.0" },
    });
    assert(
      Reflect.get(init, "result") !== undefined,
      `MCP initialize 被拒：${JSON.stringify(init)}`,
    );
  } catch (error: unknown) {
    await stopProc(proc);
    throw error;
  }
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

  const call = async (tool: string, args: JsonObject): Promise<McpResult> => {
    const reply = await request("tools/call", { name: tool, arguments: args });
    const result = Reflect.get(reply, "result");
    assert(
      typeof result === "object" && result !== null,
      `tools/call ${tool} 缺 result：${JSON.stringify(reply)}`,
    );
    const record = result as JsonObject;
    const content = record["content"];
    const first =
      Array.isArray(content) && content.length > 0 ? (content[0] as JsonObject) : undefined;
    const text = first !== undefined && typeof first["text"] === "string" ? first["text"] : "";
    return { isError: record["isError"] === true, text, raw: record };
  };

  return {
    proc,
    call,
    close: async () => await stopProc(proc),
  };
};

/** 工具回执里的单行 JSON 文本（`hr_patch_node` 等把结果 JSON 打在 content.text 里）。 */
export const toolJson = (result: McpResult, label: string): JsonObject => {
  assert(!result.isError, `${label}：工具报错 ${result.text.slice(0, 300)}`);
  const parsed = parseJson(result.text, label);
  assert(typeof parsed === "object" && parsed !== null, `${label}：工具回执不是对象`);
  return parsed as JsonObject;
};
