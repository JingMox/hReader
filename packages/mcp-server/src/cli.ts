// 这层管：命令行 → transport / 工作区选择与启动（stdio / `--http <port>` / `--workspace <dir>` / `--help`）；不做协议逻辑。
// 与 `main.ts` 分开是为了能在进程内测：本文件只在默认 io 里读 `process`，argv 由调用方传入。

import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { homedir } from "node:os";
import { parse, resolve } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { HrError } from "@hreader/core";

import { logLine, messageOf } from "./log";
import { styleRootWarningOf } from "./styleDeps";
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

/** 严格参数解析：未知、缺值或重复参数一律回 `bad`，绝不猜测意图。 */
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

/** `listen` 之后的地址形态：TCP 给对象，命名管道给字符串，未监听为 null。 */
export const portOfAddress = (address: ReturnType<HttpServer["address"]>): number => {
  if (address === null || typeof address === "string") {
    throw new HrError("io_failure", "监听中的 HTTP server 没有 TCP 端口");
  }
  return address.port;
};

/** 端口被占用/无权限时让错误冒到 `runMain`：那里统一转成退出码 + stderr 说明。 */
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
    // 关服务不解释失败：已经在拆了，"未打开 / 连接残余"没有可执行的分支。
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

/** stdio 的 transport 由调用方给：测试用内存对，线上用 `StdioServerTransport`（绑进程流）。 */
export const cliIoOf = (transportOf: () => Transport): MainIo => ({
  startStdio: async () => {
    const mcp = createServer(process.cwd());
    const transport = transportOf();
    // SDK 的 `ReadBuffer` 超限（默认 10MB 单帧）时只调 `onerror` 然后自己 `close`：不接这一行，
    // 进程就在**一声不响**中退出，宿主只看到服务器凭空消失。
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

/** 宿主错把 `/` 或 `$HOME` 当工作区时发出显式提醒，但不阻止启动。 */
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

/** 资源缺失/过宽工作区的警告要不要打：纯函数，可直接求值验证。 */
export const warningLinesOf = (warning: string | undefined): readonly string[] =>
  warning === undefined ? [] : [warning];

/** 返回值 = 进程退出码。stdio 模式下它只在"起不来"时才回（成功后进程被 stdin 拖着）。 */
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
    // 宿主唯一能自证"工作区是哪个目录"的地方：stdio 的 stdout 是协议通道，只能写 stderr。
    // 资源缺失也不该等宿主第一次 `hr_apply_style` 才知道（仓库外布局，`L-21`）。
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
