// This layer owns: child-process primitives (one-shot exec / long-lived spawn /
// exit waiting / orphan sweeps); no test assertions.

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";

import { killPid, registerChild } from "../../leak-guard/registry.ts";

export interface RunResult {
  /** `null` means killed by a signal (check `signal` then). */
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Written to stdin, then the stream is closed; omit = stdin closes right away. */
  readonly input?: string | Uint8Array;
  /** `live` only: gives the child a writable stdin (MCP stdio needs it); omit = stdin closed. */
  readonly stdin?: boolean;
  readonly timeoutMs?: number;
}

/** Returns when done: CLI-style commands all go through here; at `timeoutMs` it's SIGKILL (not SIGTERM: a hung process must really die). */
export const run = (
  file: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> =>
  new Promise((resolve, reject) => {
    const child = execFile(
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
          reject(new Error(`process killed on timeout: ${file} ${args.join(" ")}`));
          return;
        }
        // execFile's error only appears on "non-zero exit / signal"; the result
        // goes back as-is, the caller judges the exit code.
        resolve({
          code: error === null ? 0 : typeof error.code === "number" ? error.code : null,
          signal: error !== null && typeof error.code === "string" ? error.code : null,
          stdout,
          stderr,
        });
      },
    );
    registerChild(child);
    child.stdin?.end(options.input);
  });

/** The shell-pipeline path (`| head`, `set -e` semantics are only testable through a real shell). */
export const runSh = (script: string, options: RunOptions = {}): Promise<RunResult> =>
  run("/bin/sh", ["-c", script], options);

export interface LiveProc {
  readonly proc: ChildProcess;
  readonly pid: number;
  /** Accumulated stdout/stderr (for diagnostics; line consumption goes through `nextLine`). */
  readonly out: { readonly text: () => string; readonly err: () => string };
  /** Buffered lines come first; if no new line arrives it times out to `undefined` (the caller decides). */
  readonly nextLine: (timeoutMs?: number) => Promise<string | undefined>;
  /** Resolves the exit code once exited; code is null on `signal`. */
  readonly exited: Promise<number | null>;
  readonly kill: (signal?: NodeJS.Signals) => void;
  readonly alive: () => boolean;
}

interface LineWaiter {
  readonly resolve: (line: string | undefined) => void;
  readonly timer: NodeJS.Timeout;
}

/** Long-lived process: line-buffered stdout + full retention; pending `nextLine` calls all settle as undefined when the process dies. */
export const live = (file: string, args: readonly string[], options: RunOptions = {}): LiveProc => {
  const proc = spawn(file, [...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: [options.stdin === true ? "pipe" : "ignore", "pipe", "pipe"],
    // Lead its own process group: stopProc/killAllTracked/registry sweeps can kill
    // the whole group via `-pid`, taking any grandchildren down with it.
    detached: process.platform !== "win32",
  });
  registerChild(proc, { group: process.platform !== "win32" });
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

const STOP_GRACE_MS = 3_000;
const KILL_SETTLE_MS = 5_000;

const exited = (proc: ChildProcess): boolean => proc.exitCode !== null || proc.signalCode !== null;

const waitExit = (proc: ChildProcess, deadline: number): Promise<void> =>
  new Promise((resolve) => {
    if (exited(proc)) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });

/**
 * Canonical stop for a long-lived child: SIGTERM the group, grace, SIGKILL the
 * group, then wait for real exit. Firing a signal without waiting, or killing a
 * single pid without its group, are both leaks that already happened.
 */
export const stopProc = async (lp: LiveProc, graceMs = STOP_GRACE_MS): Promise<number | null> => {
  const pid = lp.pid;
  const group = process.platform !== "win32";
  if (!exited(lp.proc) && lp.alive()) {
    killPid(pid, group, "SIGTERM");
    const settled = await Promise.race([
      lp.exited.then(() => true),
      new Promise<boolean>((resolve) => {
        setTimeout(() => {
          resolve(false);
        }, graceMs);
      }),
    ]);
    if (!settled) killPid(pid, group, "SIGKILL");
  }
  return await Promise.race([
    lp.exited,
    new Promise<null>((resolve) => {
      setTimeout(() => {
        resolve(null);
      }, KILL_SETTLE_MS);
    }),
  ]);
};

/**
 * Suite teardown's last line of defense: SIGTERM every surviving child's group,
 * grace, SIGKILL, and wait for real exit before returning — signals without the
 * wait leave daemons alive past afterAll, sometimes for good.
 */
export const killAllTracked = async (): Promise<void> => {
  const procs = [...tracked];
  const group = process.platform !== "win32";
  for (const proc of procs) {
    if (!exited(proc) && proc.pid !== undefined) killPid(proc.pid, group, "SIGTERM");
  }
  const graceDeadline = Date.now() + STOP_GRACE_MS;
  await Promise.all(procs.map((proc) => waitExit(proc, graceDeadline)));
  for (const proc of procs) {
    if (!exited(proc) && proc.pid !== undefined) killPid(proc.pid, group, "SIGKILL");
  }
  const settleDeadline = Date.now() + KILL_SETTLE_MS;
  await Promise.all(procs.map((proc) => waitExit(proc, settleDeadline)));
};

export const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Port-release probe (one piece of evidence that `hr serve` is fully dead): `listen` failing = the port was returned. */
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
