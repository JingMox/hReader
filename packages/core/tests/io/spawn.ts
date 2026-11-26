// 这层管：真实子进程的 spawn/收发消息/退出等待（IPC 队列），供 kill 与并发用例共用。

import { fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";

import { registerChild } from "../../../../tests/leak-guard/registry.ts";

const FIXTURES = join(import.meta.dirname, "..", "..", "fixtures");
const MESSAGE_TIMEOUT_MS = 20_000;

export interface ExitInfo {
  readonly code: number | null;
  readonly signal: string | null;
}

export interface FixtureWorker {
  readonly child: ChildProcess;
  readonly next: () => Promise<unknown>;
  readonly exit: Promise<ExitInfo>;
  readonly stderr: () => string;
  /** barrier 只有一个动作：放行。 */
  readonly go: () => void;
}

export const fieldOf = (message: unknown, key: string): unknown =>
  typeof message === "object" && message !== null ? Reflect.get(message, key) : undefined;

const inboxOf = (child: ChildProcess): { readonly next: () => Promise<unknown> } => {
  const inbox: unknown[] = [];
  const waiting: ((value: unknown) => void)[] = [];
  child.on("message", (message: unknown) => {
    const waiter = waiting.shift();
    if (waiter === undefined) inbox.push(message);
    else waiter(message);
  });
  const waitForMessage = (): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const queued = inbox.shift();
      if (queued !== undefined) {
        resolve(queued);
        return;
      }
      const timer = setTimeout(() => {
        reject(new Error("等子进程消息超时"));
      }, MESSAGE_TIMEOUT_MS);
      waiting.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  return { next: waitForMessage };
};

export const spawnFixture = (name: string, args: readonly string[]): FixtureWorker => {
  const child = fork(join(FIXTURES, name), [...args], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  registerChild(child);
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const { next } = inboxOf(child);
  const exit = new Promise<ExitInfo>((resolve) => {
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
  return {
    child,
    next: async () => {
      try {
        return await next();
      } catch (error) {
        throw new Error(`子进程 ${name} 未按时回话：${stderr}`, { cause: error });
      }
    },
    exit,
    stderr: () => stderr,
    go: () => {
      void child.send("go");
    },
  };
};
