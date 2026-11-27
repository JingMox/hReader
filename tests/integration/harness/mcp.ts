// This layer owns: an MCP stdio client (newline JSON-RPC: initialize →
// notifications/initialized → tools/call).
// No SDK on purpose: what the tests verify is exactly "the real binary speaks
// the real protocol", and an SDK client would hide the protocol details.

import { assert, parseJson } from "./check.ts";
import type { JsonObject } from "./cli.ts";
import { MCP_BIN } from "./env.ts";
import { live, stopProc, type LiveProc } from "./proc.ts";

export interface McpClient {
  readonly proc: LiveProc;
  /** Convenience wrapper for `tools/call`: returns `{isError, text}` (text = the first text content). */
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
    assert(proc.proc.stdin !== null, "MCP stdin unavailable");
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
          reject(new Error(`MCP request timed out: ${method}`));
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
      const parsed = parseJson(trimmed, "MCP stdout frame");
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
      `MCP initialize rejected: ${JSON.stringify(init)}`,
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
      `tools/call ${tool} missing result: ${JSON.stringify(reply)}`,
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

/** The single-line JSON text in a tool receipt (`hr_patch_node` et al. put their result JSON in content.text). */
export const toolJson = (result: McpResult, label: string): JsonObject => {
  assert(!result.isError, `${label}: tool error ${result.text.slice(0, 300)}`);
  const parsed = parseJson(result.text, label);
  assert(typeof parsed === "object" && parsed !== null, `${label}: tool receipt is not an object`);
  return parsed as JsonObject;
};
