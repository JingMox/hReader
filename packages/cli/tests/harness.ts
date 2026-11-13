// 这层管：CLI 的真子进程执行器与临时工作区（测试专用）；不做断言。
//
// 规矩（docs/03 §11）：每个子进程 `stdio: ["ignore"|fd, "pipe", "pipe"]` + 10s 硬超时，
// 否则子进程等 stdin、父进程等子进程，会静默挂死整棵套件。

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

export const TIMEOUT_MS = 10_000;

export interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly signal: NodeJS.Signals | null;
}

export interface CliOptions {
  readonly cwd?: string;
  /** 省略 = 不提供 stdin（`ignore`，读 stdin 的命令立即读到 EOF）。 */
  readonly stdin?: Uint8Array;
  /** 用一个已打开的 fd 当 stdin（例如目录 fd，用来触发非 HrError 读失败）。 */
  readonly stdinFd?: number;
  readonly env?: Readonly<Record<string, string>>;
}

export const runCli = async (
  args: readonly string[],
  options: CliOptions = {},
): Promise<CliResult> =>
  new Promise<CliResult>((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", MAIN, ...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: [options.stdinFd ?? (options.stdin === undefined ? "ignore" : "pipe"), "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI 子进程超过 ${String(TIMEOUT_MS)}ms 未退出：${args.join(" ")}`));
    }, TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, signal });
    });
    if (options.stdin !== undefined && child.stdin !== null) child.stdin.end(options.stdin);
  });

/** 顺带断言无 ANSI：所有用例都经这条通道，一处遗漏不放过。 */
export const expectNoAnsi = (result: CliResult): void => {
  if (result.stdout.includes("\u001B") || result.stderr.includes("\u001B")) {
    throw new Error(`输出含 ANSI 转义：stdout=${JSON.stringify(result.stdout.slice(0, 120))}`);
  }
};

export const withTempDir = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = mkdtempSync(join(tmpdir(), "hr-cli-"));
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** `--json` 契约：合法 JSON、恰好一个 `\n`、无缩进/尾随空格。 */
export const parseJsonLine = (text: string): unknown => {
  const newlines = text.split("\n").length - 1;
  if (newlines !== 1 || !text.endsWith("\n")) {
    throw new Error(`--json 输出必须恰好 1 个换行：${JSON.stringify(text.slice(0, 200))}`);
  }
  return JSON.parse(text);
};
