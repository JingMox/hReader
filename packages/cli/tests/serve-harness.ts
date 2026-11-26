// This layer: spawn a background `hr serve` subprocess and wait for it to print its
// address (test-only); makes no assertions.
//
// Two hard rules — each has deadlocked a run before:
//   1. **Never run `serve` in the foreground** — it never exits and the parent waits
//      forever; always spawn and kill in a finally.
//   2. Always pass `--port 0` (OS-assigned) and let serve print the real port; the test
//      reads it from the output, never races other cases on a fixed port, and never hits
//      a stale daemon left on the machine.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { fieldOf, MAIN } from "./harness.ts";

const START_TIMEOUT_MS = 15_000;

/** `stdio: ["ignore","pipe","pipe"]` 起的子进程：stdin 是 null，不能按 `WithoutNullStreams` 标。 */
type ServeChild = ChildProcessByStdio<null, Readable, Readable>;

export interface ServeHandle {
  /** 打印出来的地址（人读行里那一串，带尾斜杠）。 */
  readonly url: string;
  readonly port: number;
  /** 仅 `--json` 模式可得：`{url,port,token,pid,workspace}` 里的 token。 */
  readonly token: string;
  readonly stop: () => Promise<void>;
}

interface ServeOptions {
  /** `--json`：stdout 是 `{ok,data:{url,port,token,pid,workspace}}`；否则是人读的 `serving … on <url> (pid n)`。 */
  readonly json: boolean;
  /** daemon.json 的父目录；必须已存在（CLI 会校验）。 */
  readonly home: string;
  /** 子进程工作目录；文档路径相对它解析。 */
  readonly cwd: string;
}

const addressOf = (line: string): { url: string; port: number; token: string } => {
  if (line.startsWith("{")) {
    const data = fieldOf(JSON.parse(line), "data");
    return {
      // 读程序自己印出来的那串：`?token=` 丢了就该在这里暴露，而不是被测试重新拼一个。
      url: String(fieldOf(data, "url")),
      port: Number(fieldOf(data, "port")),
      token: String(fieldOf(data, "token")),
    };
  }
  // `serving <workspace> on http://127.0.0.1:<port>/ (pid <n>)`
  const url = /on (http:\/\/\S+)/u.exec(line)?.[1] ?? "";
  if (url === "") throw new Error(`serve 没有打印地址：${line}`);
  return { url, port: Number(/127\.0\.0\.1:(\d+)/u.exec(url)?.[1] ?? "0"), token: "" };
};

const STOP_GRACE_MS = 3_000;

/** SIGTERM 后最多等 `STOP_GRACE_MS`，再 SIGKILL：不能让一个忽略信号的 serve 挂住整棵套件。 */
const stopOf =
  (child: ServeChild): (() => Promise<void>) =>
  async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once("close", () => {
        resolve();
      });
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, STOP_GRACE_MS);
    });
  };

/** 等第一行 stdout 并解出地址；stderr 全量留着，超时或提前退出时拼进错误里。 */
const firstLineOf = (child: ServeChild): Promise<{ url: string; port: number; token: string }> =>
  new Promise((resolve, reject) => {
    let buffered = "";
    let stderr = "";
    const timer = setTimeout(() => {
      reject(new Error(`serve 在 ${String(START_TIMEOUT_MS)}ms 内没打印地址：${stderr}`));
    }, START_TIMEOUT_MS);
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      reject(new Error(`serve 提前退出（code ${String(code)}）：${stderr}`));
    });
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(timer);
      try {
        resolve(addressOf(buffered.slice(0, newline)));
      } catch (error: unknown) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });

export const startServe = async (file: string, options: ServeOptions): Promise<ServeHandle> => {
  const args = ["serve", file, "--port", "0", "--home", options.home];
  if (options.json) args.push("--json");
  const child = spawn(process.execPath, ["--experimental-strip-types", MAIN, ...args], {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  return { ...(await firstLineOf(child)), stop: stopOf(child) };
};

/** `serve --home` 指向的目录必须已存在；顺手建一个独立的 home，避免撞上本机真 daemon。 */
export const homeOf = (dir: string): string => {
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  return home;
};
