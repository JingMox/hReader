// 这层管：in-memory transport 的连接与「工具结果怎么读」——两个工具测试文件共用，避免各抄一份。
// 所有工具都以 `process.cwd()` 为 workspace，所以临时目录的切换由调用方负责。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { vi } from "vitest";

import { createServer } from "../src/server";

/** 带一条 `pending_ai` 批注的稿子：大纲/读节点/结批注三个工具都靠它。 */
export const ANNOTATED_DOC = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>草案</title></head>
<body>
<article data-hr-id="post">
<script id="hr-meta" type="application/json">{"version":"1.0","style":{"visual":"atelier-editorial","tone":"feynman-tech"},"annotations":[{"id":"ann-01","nodeId":"p-1","targetId":"p-1","anchor":{"exact":"旧结论"},"comment":"换成新数据","status":"pending_ai","createdAt":"2026-11-12T14:30:00Z"}]}</script>
<h1 data-hr-id="h1">标题</h1>
<section data-hr-id="s1"><p data-hr-id="p-1">正文</p></section>
</article>
</body>
</html>
`;

export interface Session {
  readonly client: Client;
  close(): Promise<void>;
}

export const sessionOf = async (): Promise<Session> => {
  const server = createServer(process.cwd());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "mcp-server-test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
};

export const workspaceIn = async (prefix: string): Promise<string> =>
  mkdtemp(join(tmpdir(), prefix));

export const leaveWorkspace = async (workspace: string): Promise<void> => {
  process.chdir(tmpdir());
  await rm(workspace, { recursive: true, force: true });
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const isErrorResultOf = (result: unknown): boolean =>
  isRecord(result) && result["isError"] === true;

/** 工具的正文只有文本块：拼起来就是 `okResult` 的 JSON 或 `failureOf` 的 `[code] message`。 */
export const textOf = (result: unknown): string => {
  const content = isRecord(result) ? result["content"] : undefined;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((one) =>
      isRecord(one) && one["type"] === "text" && typeof one["text"] === "string"
        ? [one["text"]]
        : [],
    )
    .join("\n");
};

export const payloadOf = (result: unknown): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(textOf(result));
  return isRecord(parsed) ? parsed : {};
};

/** 失败必须是工具结果，且错误码还在正文里。 */
export const codeOf = (result: unknown): string => /^\[([^\]]+)\]/u.exec(textOf(result))?.[1] ?? "";

export const uiUriOf = (result: unknown): string => {
  const meta = isRecord(result) ? result["_meta"] : undefined;
  const ui = isRecord(meta) ? meta["ui"] : undefined;
  return isRecord(ui) && typeof ui["resourceUri"] === "string" ? ui["resourceUri"] : "";
};

/** 把 stderr 收进内存里断言：巨型输入的失败日志不许漏进测试输出（MB 级单行曾把 CI runner 卡死）。 */
export const stderrText = (): { read(): string } => {
  const written: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  return { read: () => written.join("") };
};

/** 一段文本里最长一行的长度：日志边界用"行"量，与 runner 卡死的计量方式一致。 */
export const longestLineOf = (text: string): number =>
  text.split("\n").reduce((max, line) => Math.max(max, line.length), 0);
