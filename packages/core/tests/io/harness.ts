// 这层管：测试公用装置（临时工作区 / sha256 / 错误码断言 / 假 fs 端口 / 确定时钟与 sleeper）；不含任何断言。

import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Clock } from "../../src/io/ports";

/** 临时工作区：`finally` 清理，测试之间不共享任何路径。 */
export const withWorkspace = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "hreader-m15-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

export const sha256Of = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** history/锁的目录键：相对路径的 sha1。 */
export const sha1Of = (text: string): string =>
  createHash("sha1").update(text, "utf8").digest("hex");
export const realDirOf = (dir: string): Promise<string> => realpath(dir);
export const existsAt = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

export const mkdirAt = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true });
};

export const symlinkAt = (target: string, path: string): Promise<void> => symlink(target, path);
export const readBytesAt = (path: string): Promise<Buffer> => readFile(path);
export const readTextAt = async (path: string): Promise<string> => readFile(path, "utf8");
export const writeTextAt = (path: string, text: string): Promise<void> =>
  writeFile(path, text, "utf8");
export const writeBytesAt = (path: string, bytes: Uint8Array): Promise<void> =>
  writeFile(path, bytes);
export const namesIn = (dir: string): Promise<string[]> => readdir(dir);
export const namesInOrEmpty = async (dir: string): Promise<string[]> => {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
};

export const historyDirAt = async (dir: string, relFile: string): Promise<string> =>
  join(await realpath(dir), ".hreader", "history", sha1Of(relFile));
export const lockPathAt = async (dir: string, relFile: string): Promise<string> =>
  join(await realpath(dir), ".hreader", "locks", `${sha1Of(relFile)}.lock`);
export const historyNamesOf = async (dir: string, relFile: string): Promise<string[]> =>
  namesInOrEmpty(await historyDirAt(dir, relFile));
export const tmpLeftovers = async (dir: string): Promise<string[]> =>
  (await namesInOrEmpty(dir)).filter(
    (name) => name.startsWith(".hr-tmp.") || /\.\d{6,}$/u.test(name),
  );
const codeOfError = (error: unknown): string => {
  if (typeof error !== "object" || error === null) return "non_object_error";
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : "no_code";
};

/** 同步调用的错误码；没抛时返回 `no_throw`，让"本该失败却通过"变成断言失败。 */
export const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error: unknown) {
    return codeOfError(error);
  }
  return "no_throw";
};

export const codeOfAsync = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error: unknown) {
    return codeOfError(error);
  }
  return "no_throw";
};

export const fixedClock = (
  start: number,
): { readonly clock: Clock; readonly advance: (ms: number) => void } => {
  let now = start;
  return {
    clock: { now: () => new Date(now) },
    advance: (ms: number) => {
      now += ms;
    },
  };
};

/** 假 sleeper：默认只记录；传入时钟时同步推进虚拟时间，避免"时间自旋"的实现把测试挂成 OOM。 */
export const recordingSleep = (clock?: {
  readonly advance: (ms: number) => void;
}): {
  readonly sleep: (ms: number) => Promise<void>;
  readonly calls: readonly number[];
  readonly totalMs: () => number;
} => {
  const calls: number[] = [];
  return {
    calls,
    sleep: (ms: number) => {
      calls.push(ms);
      clock?.advance(ms);
      return Promise.resolve();
    },
    totalMs: () => calls.reduce((sum, ms) => sum + ms, 0),
  };
};

export * from "./fake-fs";
