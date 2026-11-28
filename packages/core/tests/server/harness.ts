// 这层管：服务器测试装置——真 `startServer` + 真 socket（`node:net` 原文）+ 真子进程外的 HTTP 客户端。
//
// 规矩：每个 socket 都有硬超时（挂住比失败更糟）；服务器一律 `finally` 关闭并删掉临时 home/workspace。
//
// SSE 等待的两个入口分工（`waitFor` 帧数 / `waitForEvent` 事件名）：见 `./sse-client`。

import { connect, type Socket } from "node:net";
import { request as httpRequest } from "node:http";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nodePatchDeps } from "../../src/io/node-fs";
import { nodeStyleDeps } from "../../src/style";
import { startServer, type RunningServer, type ServerDeps } from "../../src/server/server";
import type { ServerOptions } from "../../src/server/contracts";

export const DOC = [
  "<!doctype html>",
  "<html><head><title>t</title></head><body>",
  '<article data-hr-id="hr-a"><h2 data-hr-id="hr-b">标题</h2>',
  '<p data-hr-id="hr-c">正文一</p><p data-hr-id="hr-d">正文二</p></article>',
  "</body></html>",
].join("\r\n");

export interface TestServer {
  readonly server: RunningServer;
  readonly workspace: string;
  readonly home: string;
  readonly port: number;
  readonly token: string;
  readonly docId: string;
  readonly file: string;
  readonly close: () => Promise<void>;
}

const contextOf = (server: RunningServer, workspace: string, home: string): TestServer => ({
  server,
  workspace,
  home,
  port: server.port,
  token: server.token,
  docId: "doc.html",
  file: join(workspace, "doc.html"),
  close: async () => {
    await server.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  },
});

export const withServer = async (
  run: (ctx: TestServer) => Promise<void>,
  tuning?: ServerOptions["timeouts"] | ((workspace: string) => void),
  deps?: Partial<ServerDeps>,
  extra?: Partial<ServerOptions>,
): Promise<void> => {
  const seed = typeof tuning === "function" ? tuning : defaultSeed;
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "hr-srv-ws-")));
  const home = realpathSync(mkdtempSync(join(tmpdir(), "hr-srv-home-")));
  seed(workspace);
  const options: ServerOptions = {
    workspace,
    port: 0,
    home,
    docId: "doc.html",
    ...(typeof tuning === "object" ? { timeouts: tuning } : {}),
    ...extra,
  };
  const server = await startServer(options, {
    patch: nodePatchDeps,
    style: nodeStyleDeps(workspace),
    now: Date.now,
    ...deps,
  });
  const ctx = contextOf(server, workspace, home);
  try {
    await run(ctx);
  } finally {
    await ctx.close();
  }
};

export const defaultSeed = (workspace: string): void => {
  writeFileSync(join(workspace, "doc.html"), DOC, "utf8");
  writeFileSync(join(workspace, "other.html"), DOC, "utf8");
};

/** HTTP 请求硬超时：必须 < vitest 默认 5000ms，否则断言文本出不来，vitest 先报 `Test timed out`。 */
const HTTP_DEADLINE_MS = 4000;

/** 原文请求：写到 `until` 出现（或 socket 关闭）为止，带硬超时。 */
export const rawExchange = (
  port: number,
  text: string,
  until?: string,
  timeoutMs = HTTP_DEADLINE_MS,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const socket: Socket = connect({ host: "127.0.0.1", port });
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(Buffer.concat(chunks).toString("latin1"));
    };
    const timer = setTimeout(finish, timeoutMs);
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      if (until !== undefined && Buffer.concat(chunks).toString("latin1").includes(until)) finish();
    });
    socket.on("end", finish);
    socket.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    socket.on("connect", () => socket.write(text, "latin1"));
  });

export { rawExchangeUntil } from "./raw-until";

export interface HttpOptions {
  readonly method?: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly listen?: number;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

const ABSOLUTE = /^[a-z]+:\/\//iu;

export const httpCall = (port: number, options: HttpOptions): Promise<HttpResponse> =>
  new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "GET",
        path: ABSOLUTE.test(options.path)
          ? options.path
          : `http://127.0.0.1:${String(port)}${options.path}`,
        headers: options.headers ?? {},
        timeout: options.listen ?? HTTP_DEADLINE_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("HTTP 请求超时"));
    });
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });

export const jsonBodyOf = (response: HttpResponse): unknown => JSON.parse(response.body);

/**
 * `/s/<docId>` is only the entry now: it 302s into the capability-gated
 * `/f/<cap>/<name>` URL that actually serves the page. Follow the pair and
 * return the frame response — deliberately without the cookie on the second
 * hop, since the cap itself is the credential.
 */
export const docPageOf = async (
  port: number,
  token: string,
  docId: string,
): Promise<HttpResponse> => {
  const entry = await httpCall(port, {
    path: `/s/${encodeURIComponent(docId)}`,
    headers: { cookie: cookieOf(token) },
  });
  const location = entry.headers["location"];
  if (entry.status !== 302 || typeof location !== "string") return entry;
  return httpCall(port, { path: location });
};

// SSE 连接拆在同目录 `sse-client.ts`（文件长度门禁），对外仍从 harness 取，保持既有调用点不变。
export { openSse, SSE_DEADLINE_MS, type SseFrame } from "./sse-client";

export const cookieOf = (token: string): string => `hr=${token}`;

export const readText = (path: string): string => readFileSync(path, "utf8");
