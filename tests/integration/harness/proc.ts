// 这层管：子进程原语（一次性执行 / 常驻 spawn / 退出等待 / 孤儿清扫）；不含测试断言。

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";

export interface RunResult {
  /** `null` 表示被信号杀死（那时看 `signal`）。 */
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** 写到 stdin 后关流；不给 = stdin 直接关。 */
  readonly input?: string | Uint8Array;
  /** `live` 专用：给子进程接可写 stdin（MCP stdio 要它）；不给 = stdin 关闭。 */
  readonly stdin?: boolean;
  readonly timeoutMs?: number;
}

/** 跑完即回：CLI 类命令都走这里；`timeoutMs` 到时 SIGKILL（不是 SIGTERM：卡死的进程要真的死）。 */
export const run = (
  file: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        timeout: options.timeoutMs ?? 60_000,
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error !== null && error.killed === true) {
          reject(new Error(`进程超时被杀：${file} ${args.join(" ")}`));
          return;
        }
        // execFile 的 error 只在"非 0 退出 / 信号"时出现；结果照原样回传，退出码由调用方判。
        resolve({
          code: error === null ? 0 : typeof error.code === "number" ? error.code : null,
          signal: error !== null && typeof error.code === "string" ? error.code : null,
          stdout,
          stderr,
        });
      },
    ).stdin?.end(options.input);
  });

/** shell 管道路线（`| head`、`set -e` 语义只有真 shell 才测得出来）。 */
export const runSh = (script: string, options: RunOptions = {}): Promise<RunResult> =>
  run("/bin/sh", ["-c", script], options);

export interface LiveProc {
  readonly proc: ChildProcess;
  readonly pid: number;
  /** 累计 stdout/stderr（诊断用；行消费走 `nextLine`）。 */
  readonly out: { readonly text: () => string; readonly err: () => string };
  /** 已缓冲的行先吐；等不到新行就超时 `undefined`（调用方判）。 */
  readonly nextLine: (timeoutMs?: number) => Promise<string | undefined>;
  /** 已退出则 resolve 退出码；`signal` 时 code 为 null。 */
  readonly exited: Promise<number | null>;
  readonly kill: (signal?: NodeJS.Signals) => void;
  readonly alive: () => boolean;
}

interface LineWaiter {
  readonly resolve: (line: string | undefined) => void;
  readonly timer: NodeJS.Timeout;
}

/** 常驻进程：行缓冲 stdout + 全量留底；进程死掉时挂着的 `nextLine` 一律 undefined 收尾。 */
export const live = (file: string, args: readonly string[], options: RunOptions = {}): LiveProc => {
  const proc = spawn(file, [...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: [options.stdin === true ? "pipe" : "ignore", "pipe", "pipe"],
  });
  const pid = proc.pid ?? -1;
  let outText = "";
  let errText = "";
  let buffer = "";
  const lines: string[] = [];
  const waiters: LineWaiter[] = [];
  const pump = (): void => {
    while (lines.length > 0 && waiters.length > 0) {
      const waiter = waiters.shift();
      const line = lines.shift();
      if (waiter === undefined || line === undefined) return;
      clearTimeout(waiter.timer);
      waiter.resolve(line);
    }
  };
  const drain = (): void => {
    for (;;) {
      const at = buffer.indexOf("\n");
      if (at === -1) return;
      lines.push(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
    }
  };
  proc.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    outText += text;
    buffer += text;
    drain();
    pump();
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    errText += chunk.toString("utf8");
  });
  const exited = new Promise<number | null>((resolve) => {
    proc.once("exit", (code) => {
      drain();
      pump();
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.resolve(undefined);
      }
      resolve(code);
    });
  });
  track(proc);
  return {
    proc,
    pid,
    out: {
      text: () => outText,
      err: () => errText,
    },
    nextLine: (timeoutMs = 15_000) =>
      new Promise<string | undefined>((resolve) => {
        if (lines.length > 0) {
          resolve(lines.shift());
          return;
        }
        const waiter: LineWaiter = {
          resolve,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index !== -1) waiters.splice(index, 1);
            resolve(undefined);
          }, timeoutMs),
        };
        waiters.push(waiter);
      }),
    exited,
    kill: (signal = "SIGTERM") => {
      proc.kill(signal);
    },
    alive: () => {
      if (pid <= 0) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
  };
};

const tracked = new Set<ChildProcess>();

const track = (proc: ChildProcess): void => {
  tracked.add(proc);
  proc.once("exit", () => {
    tracked.delete(proc);
  });
};

/** 套件收尾的最后保险：把还在喘气的子进程全部 SIGKILL（SIGTERM 赖不掉的也算孤儿）。 */
export const killAllTracked = (): void => {
  for (const proc of tracked) {
    if (!proc.killed) proc.kill("SIGKILL");
  }
};

export const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** 端口释放探测（`hr serve` 死透的旁证之一）：`listen` 失败 = 端口已还。 */
export const portClosed = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => {
      resolve(false);
    });
    probe.listen(port, "127.0.0.1", () => {
      probe.close(() => {
        resolve(true);
      });
    });
  });

export const fileExists = (path: string): boolean => existsSync(path);
