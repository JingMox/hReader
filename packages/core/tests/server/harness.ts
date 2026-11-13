// 这层管：M2.1 的服务器测试装置——真 `startServer` + 真 socket（`node:net` 原文）+ 真子进程外的 HTTP 客户端。
//
// 规矩：每个 socket 都有硬超时（挂住比失败更糟）；服务器一律 `finally` 关闭并删掉临时 home/workspace。

import { connect, type Socket } from "node:net";
import { request as httpRequest } from "node:http";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nodePatchDeps } from "../../src/io/node-fs";
import { nodeStyleDeps } from "../../src/style";
import { startServer, type RunningServer } from "../../src/server/server";
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
  };
  const server = await startServer(options, {
    patch: nodePatchDeps,
    style: nodeStyleDeps(workspace),
    now: Date.now,
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

/** 原文请求：写到 `until` 出现（或 socket 关闭）为止，带硬超时。 */
export const rawExchange = (
  port: number,
  text: string,
  until?: string,
  timeoutMs = 5000,
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
        timeout: options.listen ?? 5000,
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

export interface SseFrame {
  readonly id: number | undefined;
  readonly event: string;
  readonly data: string;
}

const connectSse = (
  port: number,
  path: string,
  headers: Readonly<Record<string, string>>,
  timeoutMs: number,
): Socket => {
  const socket = connect({ host: "127.0.0.1", port });
  setTimeout(() => socket.destroy(), timeoutMs);
  socket.setEncoding("utf8");
  const extra = Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}\r\n`)
    .join("");
  socket.write(
    `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nAccept: text/event-stream\r\n${extra}Connection: keep-alive\r\n\r\n`,
  );
  return socket;
};

/** 把缓冲区里所有完整帧吃掉，返回剩余的半帧（注释帧不是事件，不计数）。 */
const pumpSse = (input: string, frames: SseFrame[]): string => {
  let buffer = input;
  let end = buffer.indexOf("\n\n");
  while (end >= 0) {
    const block = buffer.slice(0, end);
    if (block.includes("data:")) frames.push(frameOfRaw(block));
    buffer = buffer.slice(end + 2);
    end = buffer.indexOf("\n\n");
  }
  return buffer;
};

/** 一条 SSE 连接：按空行切帧；`close()` 后不再收。 */
const frameOfRaw = (raw: string): SseFrame => {
  const lines = raw.split("\n");
  const idLine = lines.find((line) => line.startsWith("id: "));
  return {
    id: idLine === undefined ? undefined : Number(idLine.slice(4)),
    event: eventOf(lines),
    data: lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "",
  };
};

/** 一条 SSE 连接：按空行切帧；`close()` 后不再收。 */
export const openSse = (
  port: number,
  path: string,
  headers: Readonly<Record<string, string>> = {},
  timeoutMs = 5000,
): {
  readonly frames: SseFrame[];
  readonly waitFor: (count: number) => Promise<SseFrame[]>;
  readonly close: () => void;
} => {
  const frames: SseFrame[] = [];
  let buffer = "";
  let closed = false;
  const socket = connectSse(port, path, headers, timeoutMs);
  socket.on("data", (chunk: string) => {
    buffer = pumpSse(buffer + chunk, frames);
  });
  const waitFor = async (count: number): Promise<SseFrame[]> => {
    const started = Date.now();
    while (frames.length < count && Date.now() - started < timeoutMs && !closed) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return frames;
  };
  return {
    frames,
    waitFor,
    close: () => {
      closed = true;
      socket.destroy();
    },
  };
};

/** 帧里没有 `event:` 头时，类型在 `data:` 的 JSON `type` 字段（见 event-ring.frameOf）。 */
const eventOf = (lines: readonly string[]): string => {
  const explicit = lines.find((line) => line.startsWith("event: "))?.slice(7);
  if (explicit !== undefined) return explicit;
  const data = lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "";
  return /"type":"([^"]+)"/u.exec(data)?.[1] ?? "message";
};

export const cookieOf = (token: string): string => `hr=${token}`;

export const readText = (path: string): string => readFileSync(path, "utf8");
