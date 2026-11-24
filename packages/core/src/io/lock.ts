// 这层管：按文件的互斥锁（单次 open(wx) 写全量 payload + CAS 接管）；不管历史与写入。

import { dirname } from "node:path";

import { HrError } from "../hr-error";
import { mkdirOrFail } from "./atomic";
import { decodeUtf8, encodeUtf8 } from "./bytes";
import { nonce as randomNonce } from "./digest";
import { failureOf, ioFailure, isExists, isMissing, unlinkQuiet } from "./errors";
import type { FileSystem, PatchDeps } from "./ports";
import { isProcessAlive } from "./process";

export const LOCK_RETRY_MS = 25;
export const DEFAULT_LOCK_TIMEOUT_MS = 2000;

/** 内容不可解析的锁要"老于这个年龄"才可能是崩溃残留：刚 open 出来的锁体还没来得及写。 */
const STALE_UNPARSABLE_MS = 5_000;

/** 持有者存活但超过这个年龄：多半卡死在 write 与 rename 之间，允许接管。 */
const STALE_LIVE_MS = 120_000;

interface LockHandle {
  readonly release: () => Promise<void>;
}

interface LockPayload {
  readonly pid: number;
  readonly nonce: string;
  readonly at: number;
}

/** `pid <= 0` 直接判非法：`process.kill(-1, 0)` 会探测整个进程组。 */
const payloadOf = (value: unknown): LockPayload | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const pid: unknown = Reflect.get(value, "pid");
  const nonce: unknown = Reflect.get(value, "nonce");
  const at: unknown = Reflect.get(value, "at");
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
  if (typeof nonce !== "string" || nonce.length === 0) return undefined;
  if (typeof at !== "number" || !Number.isFinite(at)) return undefined;
  return { pid, nonce, at };
};

/**
 * 只有"锁已经不在了"（ENOENT）才算不存在；EACCES/EISDIR 是基础设施故障，
 * 当成"不存在"会直接把别人的锁抢掉。内容坏/不是 JSON 仍按"不可解析"处理。
 */
const readPayloadOf = async (fsApi: FileSystem, path: string): Promise<LockPayload | undefined> => {
  let bytes: Uint8Array;
  try {
    bytes = await fsApi.readFile(path);
  } catch (error: unknown) {
    if (isMissing(error)) return undefined;
    throw ioFailure("读取锁文件", path, error);
  }
  try {
    return payloadOf(JSON.parse(decodeUtf8(bytes, path)));
  } catch {
    return undefined;
  }
};

/**
 * 读不到年龄就不能声称它“老”：返回 0 让 `isStale` 走“不陈旧”，
 * 否则 lstat 的 ENOENT/EACCES 会被当成 `MAX_SAFE_INTEGER`，把刚创建的锁判成陈旧并抢走（会丢写）。
 */
const ageOf = async (deps: PatchDeps, path: string): Promise<number> => {
  try {
    const stat = await deps.fs.lstat(path);
    return deps.clock.now().getTime() - stat.mtimeMs;
  } catch {
    return 0;
  }
};

const isStale = (payload: LockPayload | undefined, age: number): boolean => {
  if (payload === undefined) return age > STALE_UNPARSABLE_MS;
  if (!isProcessAlive(payload.pid)) return true;
  return age > STALE_LIVE_MS;
};

/** 一次 `open(wx)` + 一次写入：文件出现时内容就是完整 JSON，没有"空锁体"窗口。 */
const tryCreate = async (deps: PatchDeps, path: string, payload: Uint8Array): Promise<boolean> => {
  try {
    const file = await deps.fs.open(path);
    try {
      await file.write(payload);
      await file.sync();
    } finally {
      await deps.fs.close(file);
    }
    return true;
  } catch (error: unknown) {
    if (isExists(error)) return false;
    throw failureOf("创建锁文件", path, error);
  }
};

/** 接管是 CAS：判定陈旧与移走之间可能被“新的持有者”换过，rename 前再验一次同一把锁。 */
const trySteal = async (deps: PatchDeps, path: string, nonce: string): Promise<boolean> => {
  const payload = await readPayloadOf(deps.fs, path);
  if (!isStale(payload, await ageOf(deps, path))) return false;
  const again = await readPayloadOf(deps.fs, path);
  if (again?.nonce !== payload?.nonce) return false;
  const stealPath = `${path}.steal-${nonce}`;
  try {
    await deps.fs.rename(path, stealPath);
  } catch {
    // 别人先接管 / 持有者自己释放了：回主循环重试 open，不算故障。
    return false;
  }
  const moved = await readPayloadOf(deps.fs, stealPath);
  if (moved?.nonce === payload?.nonce) {
    await unlinkQuiet(deps.fs, stealPath);
    return true;
  }
  // CAS 不符说明 path 上已经是别人新拿的锁：丢掉我们移走的旧副本，绝不写回（写回会盖掉新锁）。
  await unlinkQuiet(deps.fs, stealPath);
  return false;
};

/** 读不到就无法证明锁是我们的：保留锁（等陈旧接管），且释锁本身不许抛。 */
const releaseLock = async (fsApi: FileSystem, path: string, nonce: string): Promise<void> => {
  let payload: LockPayload | undefined;
  try {
    payload = await readPayloadOf(fsApi, path);
  } catch {
    return;
  }
  if (payload?.nonce !== nonce) return;
  await unlinkQuiet(fsApi, path);
};

/** 编排层唯一的加锁入口：`finally` 释锁，正文抛错也不会把锁留在盘上。 */
export const runLocked = async <T>(
  target: { readonly lockPath: string },
  deps: PatchDeps,
  options: { readonly lockTimeoutMs?: number },
  work: () => Promise<T>,
): Promise<T> => {
  const lock = await acquireLock(
    { path: target.lockPath, timeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS },
    deps,
  );
  try {
    return await work();
  } finally {
    await lock.release();
  }
};

export const acquireLock = async (
  input: { readonly path: string; readonly timeoutMs: number },
  deps: PatchDeps,
): Promise<LockHandle> => {
  const deadline = deps.clock.now().getTime() + input.timeoutMs;
  const nonce = randomNonce();
  const payload = encodeUtf8(
    JSON.stringify({ pid: process.pid, nonce, at: deps.clock.now().getTime() }),
  );
  await mkdirOrFail(deps, dirname(input.path));
  for (;;) {
    if (await tryCreate(deps, input.path, payload)) {
      // 创建到开工之间也可能被接管（别的进程判我们陈旧）：非本 nonce 就放弃，宁可重试也不并发写。
      const held = await readPayloadOf(deps.fs, input.path).catch(() => undefined);
      if (held?.nonce !== nonce) {
        throw new HrError("locked", `锁在取得后即被接管：${input.path}`);
      }
      return { release: () => releaseLock(deps.fs, input.path, nonce) };
    }
    if (await trySteal(deps, input.path, nonce)) continue;
    if (deps.clock.now().getTime() >= deadline) {
      throw new HrError(
        "locked",
        `文件被其他进程占用（等锁 ${String(input.timeoutMs)}ms）：${input.path}`,
      );
    }
    await deps.sleep(LOCK_RETRY_MS);
  }
};
