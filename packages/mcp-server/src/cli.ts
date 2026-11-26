// This layer: command line → transport / workspace selection and startup (stdio / `--http <port>` / `--workspace <dir>` / `--help`); no protocol logic.
// Split from `main.ts` so it can be tested in-process: this file only reads `process` through injected io, and argv comes from the caller.

import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { homedir } from "node:os";
import { parse, resolve } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { HrError } from "@hreader/core";

import { logLine, messageOf } from "./log";
import { styleRootWarningOf } from "./style-deps";
import { createServer } from "./server";

export const USAGE = [
  "hreader-mcp —— hreader 的 MCP Server",
  "",
  "用法：",
  "  hreader-mcp [--workspace <dir>]                stdio 传输（MCP 宿主直接拉起；默认）",
  "  hreader-mcp --http <port> [--workspace <dir>]  在 127.0.0.1:<port> 上开 Streamable HTTP",
  "  hreader-mcp --help                             显示本帮助",
].join("\n");

export type Mode =
  | { readonly kind: "stdio"; readonly workspace?: string }
  | { readonly kind: "http"; readonly port: number; readonly workspace?: string }
  | { readonly kind: "help" }
  | { readonly kind: "bad"; readonly reason: string };

interface FlagState {
  port?: number;
  workspace?: string;
}

const parseHttpFlag = (value: string | undefined, state: FlagState): string | undefined => {
  if (state.port !== undefined) return "重复的参数：--http";
  if (value === undefined) return "缺少端口：--http";
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    return `端口不合法：${value}`;
  }
  state.port = port;
  return undefined;
};

const parseWorkspaceFlag = (value: string | undefined, state: FlagState): string | undefined => {
  if (state.workspace !== undefined) return "重复的参数：--workspace";
  if (value === undefined || value.trim() === "") return "缺少工作区路径：--workspace";
  state.workspace = value;
  return undefined;
};

/** Strict argument parsing: unknown, missing-value, or repeated arguments all return `bad`; intent is never guessed. */
export const modeOf = (argv: readonly string[]): Mode => {
  if (argv.includes("--help")) return { kind: "help" };
  const state: FlagState = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    const reason =
      flag === "--http"
        ? parseHttpFlag(value, state)
        : flag === "--workspace"
          ? parseWorkspaceFlag(value, state)
          : `无法识别的参数：${argv.join(" ")}`;
    if (reason !== undefined) return { kind: "bad", reason };
  }
  const ws = state.workspace === undefined ? {} : { workspace: state.workspace };
  return state.port === undefined
    ? { kind: "stdio", ...ws }
    : { kind: "http", port: state.port, ...ws };
};

export interface RunningHttp {
  readonly port: number;
  close(): Promise<void>;
}

/** Address shape after `listen`: an object for TCP, a string for named pipes, null when not listening. */
export const portOfAddress = (address: ReturnType<HttpServer["address"]>): number => {
  if (address === null || typeof address === "string") {
    throw new HrError("io_failure", "监听中的 HTTP server 没有 TCP 端口");
  }
  return address.port;
};

/** When the port is taken or forbidden, let the error bubble up to `runMain`: it is turned into an exit code + stderr note there. */
export const startHttp = async (port: number): Promise<RunningHttp> => {
  const mcp = createServer(process.cwd());
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await mcp.connect(transport);
  const http = createHttpServer((request, response) => {
    void transport.handleRequest(request, response);
  });
  await new Promise<void>((resolveHttp, reject) => {
    http.once("error", reject);
    http.listen(port, "127.0.0.1", resolveHttp);
  });
  return {
    port: portOfAddress(http.address()),
    // Shutdown failures are not explained: we are already tearing down, and "not open / leftover connection" has no actionable branch.
    close: async () => {
      await new Promise<void>((resolveClose) => {
        http.close(() => {
          resolveClose();
        });
      });
      await mcp.close();
    },
  };
};

export interface MainIo {
  readonly startStdio: () => Promise<void>;
  readonly startHttp: (port: number) => Promise<RunningHttp>;
  readonly chdir?: (dir: string) => void;
}

/** The stdio transport is supplied by the caller: tests use an in-memory pair, production uses `StdioServerTransport` (bound to the process streams). */
export const cliIoOf = (transportOf: () => Transport): MainIo => ({
  startStdio: async () => {
    const mcp = createServer(process.cwd());
    const transport = transportOf();
    // When the SDK's `ReadBuffer` overflows (10MB per frame by default) it only calls `onerror` and then closes itself: without this line,
    // the process exits **silently** and the host just sees the server vanish.
    transport.onerror = (error: Error) => {
      logLine(`传输错误：${messageOf(error)}`);
    };
    await mcp.connect(transport);
  },
  startHttp,
});

const defaultIo = cliIoOf(() => new StdioServerTransport());

const defaultChdir = (dir: string): void => {
  process.chdir(resolve(dir));
};

/** Warns explicitly when the host mistakes `/` or `$HOME` for the workspace, without blocking startup. */
export const workspaceWarningOf = (
  workspace: string,
  home: string = homedir(),
): string | undefined => {
  const resolved = resolve(workspace);
  const isRoot = parse(resolved).root === resolved;
  const isHome = resolved === resolve(home);
  if (!isRoot && !isHome) return undefined;
  return `WARNING 工作区范围过大（${resolved}）：建议通过 --workspace <dir> 限定文档目录`;
};

/** Whether to print the missing-resources / overly-wide-workspace warning: a pure function, directly evaluable in tests. */
export const warningLinesOf = (warning: string | undefined): readonly string[] =>
  warning === undefined ? [] : [warning];

/** Return value = process exit code. In stdio mode it only returns when startup fails (on success the process is held by stdin). */
export const runMain = async (argv: readonly string[], io: MainIo = defaultIo): Promise<number> => {
  const mode = modeOf(argv);
  if (mode.kind === "help") {
    logLine(USAGE);
    return 0;
  }
  if (mode.kind === "bad") {
    logLine(`${mode.reason}\n\n${USAGE}`);
    return 2;
  }
  try {
    if (mode.workspace !== undefined) (io.chdir ?? defaultChdir)(mode.workspace);
    const workspace = process.cwd();
    // The only place the host can prove which directory the workspace is: in stdio, stdout is the protocol channel, so this goes to stderr.
    // Missing resources should not wait for the host's first `hr_apply_style` to surface (out-of-repo layouts).
    [
      `workspace=${workspace}`,
      ...warningLinesOf(workspaceWarningOf(workspace)),
      ...warningLinesOf(styleRootWarningOf(workspace)),
    ].forEach((line) => {
      logLine(line);
    });
    if (mode.kind === "stdio") {
      await io.startStdio();
      return 0;
    }
    const running = await io.startHttp(mode.port);
    logLine(`HTTP 传输就绪：http://127.0.0.1:${String(running.port)}/`);
    return 0;
  } catch (error: unknown) {
    logLine(`启动失败：${messageOf(error)}`);
    return 1;
  }
};
