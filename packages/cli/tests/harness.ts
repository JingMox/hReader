// 这层管：CLI 的真子进程执行器与临时工作区（测试专用）；不做断言。
//
// 规矩（docs/03 §11）：每个子进程 `stdio: ["ignore"|fd, "pipe", "pipe"]` + 10s 硬超时，
// 否则子进程等 stdin、父进程等子进程，会静默挂死整棵套件。

import { spawn, type ChildProcess } from "node:child_process";
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

/** 挂上 stdout/stderr 与超时/退出事件的监听（body 拆出去，免得单函数过 40 行）。 */
const wire = (
  child: ChildProcess,
  args: readonly string[],
  resolve: (result: CliResult) => void,
  reject: (error: Error) => void,
): void => {
  let stdout = "";
  let stderr = "";
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    reject(new Error(`CLI 子进程超过 ${String(TIMEOUT_MS)}ms 未退出：${args.join(" ")}`));
  }, TIMEOUT_MS);

  const out = child.stdout;
  const errOut = child.stderr;
  if (out === null || errOut === null) {
    reject(new Error("子进程的 stdout/stderr 不是管道：检查 spawn 的 stdio"));
    return;
  }
  out.setEncoding("utf8");
  errOut.setEncoding("utf8");
  out.on("data", (chunk: string) => {
    stdout += chunk;
  });
  errOut.on("data", (chunk: string) => {
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
};

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
    if (child.stdout === null || child.stderr === null) {
      reject(new Error("子进程的 stdout/stderr 不是管道：检查 spawn 的 stdio"));
      return;
    }
    wire(child, args, resolve, reject);
    if (options.stdin !== undefined && child.stdin !== null) child.stdin.end(options.stdin);
  });

/** 顺带断言无 ANSI：所有用例都经这条通道，一处遗漏不放过。 */
export const expectNoAnsi = (result: CliResult): void => {
  if (result.stdout.includes("\u001B") || result.stderr.includes("\u001B")) {
    throw new Error(`输出含 ANSI 转义：stdout=${JSON.stringify(result.stdout.slice(0, 120))}`);
  }
};

export const withTempDir = async <T>(
  run: (dir: string) => Promise<T>,
  timeoutMs = 10_000,
): Promise<T> => {
  const dir = mkdtempSync(join(tmpdir(), "hr-cli-"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(dir),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`withTempDir 超过 ${String(timeoutMs)}ms 未完成`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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

/** 从 `--json` 信封里按路径取字段（`fieldOf(env, "data")`），避免测试里写 `as` 断言。 */
export const fieldOf = (value: unknown, key: string): unknown => Reflect.get(Object(value), key);

/** 对象自有键（顺序敏感）：`--json` 的键序契约用它断言。 */
export const keysOf = (value: unknown): readonly string[] =>
  typeof value === "object" && value !== null
    ? Reflect.ownKeys(value).map((key) => String(key))
    : [];

/** 数组/对象按下标取值（配合 `keysOf` 断言嵌套键序）。 */
export const atOf = (value: unknown, index: number): unknown =>
  Reflect.get(Object(value), String(index));

/** 假 fetch 拿到的第一个参数可能是字符串/URL/Request：一律折成 URL 文本，供 `toContain`/相等断言。 */
export const fetchUrlOf = (input: Parameters<typeof globalThis.fetch>[0]): string => {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
};

/** 请求体原文（假 fetch 只写字符串体）；非字符串体折成空串，避免测试里做 `as` 断言。 */
export const fetchBodyOf = (init: Parameters<typeof globalThis.fetch>[1]): string => {
  const body: unknown = init?.body;
  return typeof body === "string" ? body : "";
};

/** 只接受字符串的字段（其余一律序列化），让 `toContain` 不依赖断言。 */
export const textOf = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);
