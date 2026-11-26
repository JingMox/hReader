// This layer is the real-subprocess executor and temp workspace for CLI tests (test-only); no assertions.
//
// The rule: every subprocess gets `stdio: ["ignore"|fd, "pipe", "pipe"]` + a 10s hard timeout,
// otherwise the child waits on stdin while the parent waits on the child — a silent hang for the whole suite.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
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
  /** Omitted = no stdin provided (`ignore`; a command reading stdin gets EOF immediately). */
  readonly stdin?: Uint8Array;
  /** Use an already-open fd as stdin (e.g. a directory fd, to trigger a non-HrError read failure). */
  readonly stdinFd?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

/** Attach listeners for stdout/stderr and timeout/exit events (the body lives elsewhere to keep the function under 40 lines). */
const wire = (
  child: ChildProcess,
  args: readonly string[],
  timeoutMs: number,
  done: { readonly resolve: (result: CliResult) => void; readonly reject: (error: Error) => void },
): void => {
  let stdout = "";
  let stderr = "";
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    done.reject(new Error(`CLI 子进程超过 ${String(timeoutMs)}ms 未退出：${args.join(" ")}`));
  }, timeoutMs);

  const out = child.stdout;
  const errOut = child.stderr;
  if (out === null || errOut === null) {
    done.reject(new Error("subprocess stdout/stderr are not pipes: check the spawn stdio"));
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
    done.reject(error);
  });
  child.on("close", (code, signal) => {
    clearTimeout(timer);
    done.resolve({ code, stdout, stderr, signal });
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
      reject(new Error("subprocess stdout/stderr are not pipes: check the spawn stdio"));
      return;
    }
    wire(child, args, options.timeoutMs ?? TIMEOUT_MS, { resolve, reject });
    if (options.stdin !== undefined && child.stdin !== null) child.stdin.end(options.stdin);
  });

/** Assert no ANSI along the way: every case passes through this channel, so no omission escapes. */
export const expectNoAnsi = (result: CliResult): void => {
  if (result.stdout.includes("\u001B") || result.stderr.includes("\u001B")) {
    throw new Error(`输出含 ANSI 转义：stdout=${JSON.stringify(result.stdout.slice(0, 120))}`);
  }
};

/**
 * Temp workspaces all go through `realpathSync`: macOS `$TMPDIR` is `/var/...` while the kernel returns
 * `/private/var/...` — without normalization, legal paths get judged `path_outside_workspace`.
 */
export const withTempDir = async <T>(
  run: (dir: string) => Promise<T>,
  timeoutMs = 10_000,
): Promise<T> => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hr-cli-")));
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

/** `--json` contract: valid JSON, exactly one `\n`, no indentation/trailing spaces. */
export const parseJsonLine = (text: string): unknown => {
  const newlines = text.split("\n").length - 1;
  if (newlines !== 1 || !text.endsWith("\n")) {
    throw new Error(`--json 输出必须恰好 1 个换行：${JSON.stringify(text.slice(0, 200))}`);
  }
  return JSON.parse(text);
};

/** Read a field out of the `--json` envelope by path (`fieldOf(env, "data")`), avoiding `as` assertions in tests. */
export const fieldOf = (value: unknown, key: string): unknown => Reflect.get(Object(value), key);

/** An object's own keys (order-sensitive): used to assert the `--json` key-order contract. */
export const keysOf = (value: unknown): readonly string[] =>
  typeof value === "object" && value !== null
    ? Reflect.ownKeys(value).map((key) => String(key))
    : [];

/** Iterate elements of an array field in `--json` (non-arrays collapse to empty), avoiding `unknown[]` assertions in tests. */
export const listOf = (value: unknown): readonly unknown[] =>
  Array.isArray(value)
    ? keysOf(value)
        .filter((key) => key !== "length")
        .map((key) => fieldOf(value, key))
    : [];

/** Index into an array/object (paired with `keysOf` to assert nested key order). */
export const atOf = (value: unknown, index: number): unknown =>
  Reflect.get(Object(value), String(index));

/** The fake fetch's first argument may be string/URL/Request: always fold it to URL text for `toContain`/equality assertions. */
export const fetchUrlOf = (input: Parameters<typeof globalThis.fetch>[0]): string => {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
};

/** The raw request body (fake fetch only writes string bodies); non-string bodies fold to "", avoiding `as` in tests. */
export const fetchBodyOf = (init: Parameters<typeof globalThis.fetch>[1]): string => {
  const body: unknown = init?.body;
  return typeof body === "string" ? body : "";
};

/** String-only fields (everything else gets serialized), so `toContain` needs no assertion. */
export const textOf = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);
