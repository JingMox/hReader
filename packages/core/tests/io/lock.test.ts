// 这层管：锁的重试/超时边界（假时钟不真等）、陈旧锁接管、释锁幂等与错误路径；不碰内容层。

import { describe, expect, it } from "vitest";

import { encodeUtf8 } from "../../src/io/bytes";
import { HrError } from "../../src/hr-error";
import { acquireLock, runLocked, DEFAULT_LOCK_TIMEOUT_MS, LOCK_RETRY_MS } from "../../src/io/lock";
import type { ResolvedTarget } from "../../src/io/paths";
import type { PatchDeps } from "../../src/io/ports";
import {
  codeOfAsync,
  depsOf,
  fakeFs,
  fixedClock,
  recordingSleep,
  sha1Of,
  systemError,
  type FakeFs,
} from "./harness";

const NOW = 1_700_000_000_000;
const WS = "/ws";
const DOC = "a.html";
const LOCK_PATH = `/ws/.hreader/locks/${sha1Of("a.html")}.lock`;
const OWNER = "others000001";

const payloadOf = (at: number, overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({ pid: process.pid, nonce: OWNER, at, ...overrides });

/** 每个用例一座钟 + 推进这座钟的 sleep：acquireLock 的截止与重试步进必须同源；
 *  共用模块级时钟会让先跑用例的重试把时间推进到后跑用例的断言里（乱序即炸）。 */
const rigged = (
  fake: FakeFs,
): { readonly deps: PatchDeps; readonly sleep: ReturnType<typeof recordingSleep> } => {
  const local = fixedClock(NOW);
  const sleep = recordingSleep(local);
  return { deps: depsOf(fake.port, local.clock, sleep.sleep), sleep };
};

const seeded = (content: string): FakeFs => fakeFs({ "/ws/a.html": "x", [LOCK_PATH]: content });

const lockedWith = async (fake: FakeFs, timeoutMs: number, deps?: PatchDeps): Promise<string> =>
  codeOfAsync(() => acquireLock({ path: LOCK_PATH, timeoutMs }, deps ?? rigged(fake).deps));

describe("acquireLock · 创建与释锁", () => {
  it("should write an owner payload and delete the lock on release", async () => {
    const fake = fakeFs({ "/ws/a.html": "x" });
    const handle = await acquireLock({ path: LOCK_PATH, timeoutMs: 0 }, rigged(fake).deps);
    const payload: unknown = JSON.parse(fake.textAt(LOCK_PATH));

    expect(Reflect.get(Object(payload), "pid")).toBe(process.pid);
    expect(Reflect.get(Object(payload), "nonce")).toMatch(/^[0-9a-f]{12}$/u);
    expect(Reflect.get(Object(payload), "at")).toBe(NOW);
    await handle.release();
    expect(fake.state.files.has(LOCK_PATH)).toBe(false);
  });

  it("should keep a lock that was taken over while we held it", async () => {
    const fake = fakeFs({ "/ws/a.html": "x" });
    const handle = await acquireLock({ path: LOCK_PATH, timeoutMs: 0 }, rigged(fake).deps);
    fake.state.files.set(LOCK_PATH, encodeUtf8(payloadOf(NOW)));
    await handle.release();

    expect(fake.state.files.has(LOCK_PATH)).toBe(true);
  });

  it("should swallow release read errors so the real error survives", async () => {
    const fake = fakeFs({ "/ws/a.html": "x" });
    const handle = await acquireLock({ path: LOCK_PATH, timeoutMs: 0 }, rigged(fake).deps);
    fake.fail("readFile", systemError("EACCES"));
    await expect(handle.release()).resolves.toBeUndefined();

    expect(fake.state.files.has(LOCK_PATH)).toBe(true);
  });
});
describe("acquireLock · 重试超时", () => {
  it("should retry every 25ms for the default 2000ms budget and then report locked", async () => {
    const fake = seeded(payloadOf(NOW));
    const { deps, sleep } = rigged(fake);
    expect(await lockedWith(fake, DEFAULT_LOCK_TIMEOUT_MS, deps)).toBe("locked");

    expect(sleep.calls).toHaveLength(Math.ceil(DEFAULT_LOCK_TIMEOUT_MS / LOCK_RETRY_MS));
    expect(sleep.calls).toHaveLength(80);
    expect(sleep.totalMs()).toBe(2000);
    expect(sleep.calls.every((ms) => ms === LOCK_RETRY_MS)).toBe(true);
  });

  it("should name the lock path in the locked error", async () => {
    const fake = seeded(payloadOf(NOW));
    const failure = await acquireLock({ path: LOCK_PATH, timeoutMs: 0 }, rigged(fake).deps).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(HrError);
    expect(String(Reflect.get(Object(failure), "message"))).toContain(LOCK_PATH);
  });
});
describe("acquireLock · 陈旧判定边界", () => {
  it("should keep a 120000ms old lock from a live pid and time out", async () => {
    const local = fixedClock(NOW);
    const sleep = recordingSleep(local);
    const fake = seeded(payloadOf(NOW - 120_000));
    fake.state.mtimes.set(LOCK_PATH, NOW - 120_000);

    const code = await codeOfAsync(() =>
      acquireLock({ path: LOCK_PATH, timeoutMs: 0 }, depsOf(fake.port, local.clock, sleep.sleep)),
    );

    expect(code).toBe("locked");
    expect(sleep.calls).toEqual([]);
  });

  it("should take over a lock one millisecond past the live-pid window", async () => {
    const fake = seeded(payloadOf(NOW - 120_000 - 1));
    const { deps, sleep } = rigged(fake);
    fake.state.mtimes.set(LOCK_PATH, NOW - 120_000 - 1);
    const handle = await acquireLock({ path: LOCK_PATH, timeoutMs: 0 }, deps);

    expect(sleep.calls).toEqual([]);
    expect(fake.state.files.has(LOCK_PATH)).toBe(true);
    await handle.release();
  });
});
describe("acquireLock · 接管各种残骸", () => {
  it.each([
    ["dead pid 0", payloadOf(NOW, { pid: 0 })],
    ["nonexistent pid", payloadOf(NOW, { pid: 999_999 })],
    ["corrupt json", "not json"],
    ["wrong shape", '{"pid":"x","nonce":1,"at":"y"}'],
    ["empty file", ""],
  ])("should take over a lock from %s", async (_label, content) => {
    const fake = seeded(content);
    fake.state.mtimes.set(LOCK_PATH, NOW - 60_000);
    const handle = await acquireLock({ path: LOCK_PATH, timeoutMs: 0 }, rigged(fake).deps);

    expect(fake.textAt(LOCK_PATH)).not.toBe(content);
    await handle.release();
    expect(fake.state.files.has(LOCK_PATH)).toBe(false);
  });

  it("should refuse a second takeover so two writers cannot livelock", async () => {
    const fake = seeded(payloadOf(NOW - 120_000 - 1));
    fake.state.mtimes.set(LOCK_PATH, NOW - 120_000 - 1);
    fake.fail("rename", systemError("EACCES"), (path) => path === LOCK_PATH);

    expect(await lockedWith(fake, 0)).toBe("locked");
    expect(fake.textAt(LOCK_PATH)).toBe(payloadOf(NOW - 120_000 - 1));
  });
});
describe("acquireLock · 基础设施故障", () => {
  it("should report io_failure when the lock directory cannot be created", async () => {
    const fake = fakeFs({ "/ws/a.html": "x" });
    fake.fail("mkdir", systemError("EACCES"));

    expect(await lockedWith(fake, 0)).toBe("io_failure");
  });

  it("should not confuse a non-EEXIST open failure with contention", async () => {
    const fake = fakeFs({ "/ws/a.html": "x" });
    fake.fail("open", systemError("EACCES"));

    expect(await lockedWith(fake, 0)).toBe("io_failure");
  });

  it("should report io_failure when the lock file itself cannot be read", async () => {
    const fake = seeded(payloadOf(NOW));
    fake.fail("readFile", systemError("EACCES"));

    expect(await lockedWith(fake, 0)).toBe("io_failure");
  });
});
describe("runLocked · 释锁时机", () => {
  const target: ResolvedTarget = {
    realPath: DOC,
    relative: DOC,
    workspace: WS,
    storeDir: `${WS}/.hreader`,
    lockPath: LOCK_PATH,
  };
  const depsFor = (fake: FakeFs): PatchDeps => rigged(fake).deps;

  it("should release after the work resolves", async () => {
    const fake = fakeFs({ "/ws/a.html": "x" });
    const value = await runLocked(target, depsFor(fake), { lockTimeoutMs: 0 }, () =>
      Promise.resolve(42),
    );

    expect(value).toBe(42);
    expect(fake.state.files.has(LOCK_PATH)).toBe(false);
  });

  it("should release even when the work throws", async () => {
    const fake = fakeFs({ "/ws/a.html": "x" });
    const work = (): Promise<never> => Promise.reject(new HrError("undo_unavailable", "x"));

    expect(
      await codeOfAsync(() => runLocked(target, depsFor(fake), { lockTimeoutMs: 0 }, work)),
    ).toBe("undo_unavailable");
    expect(fake.state.files.has(LOCK_PATH)).toBe(false);
  });
});
describe("acquireLock · 接管 CAS 不符（读完之后锁被换掉）", () => {
  it("should drop the stolen copy and retry when the nonce changed mid-takeover", async () => {
    const lock = "/ws/.hreader/locks/lock.lock";
    const fake = fakeFs({ "/ws/a.html": "x", [lock]: "" });
    for (const dir of ["/ws", "/ws/.hreader", "/ws/.hreader/locks"]) fake.state.dirs.add(dir);
    const stale = (nonce: string): string =>
      JSON.stringify({ pid: 999_999, nonce, at: NOW - 10 * 60_000 });
    fake.state.files.set(lock, new TextEncoder().encode(stale("staleaaaaaaaa")));
    fake.state.mtimes.set(lock, NOW - 10 * 60_000);
    // 读完"判陈旧"的那一份之后，把锁换成另一把同样陈旧但 nonce 不同的锁：
    // 接管 rename 移走的不是我们刚判过的那一把 → CAS 不符，必须丢弃副本重试，绝不能写回。
    fake.once(
      "readFile",
      (path) => path === lock,
      () => {
        fake.state.files.set(lock, new TextEncoder().encode(stale("stalebbbbbbbb")));
      },
    );

    const handle = await acquireLock(
      { path: lock, timeoutMs: 2000 },
      depsOf(fake.port, fixedClock(NOW).clock, recordingSleep(fixedClock(NOW)).sleep),
    );

    const written: unknown = JSON.parse(fake.textAt(lock));
    expect(Reflect.get(Object(written), "pid")).toBe(process.pid);
    expect(Reflect.get(Object(written), "nonce")).not.toBe("stalebbbbbbbb");
    expect(Reflect.get(Object(written), "nonce")).not.toBe("staleaaaaaaaa");
    await handle.release();
    expect(fake.state.files.has(lock)).toBe(false);
    expect([...fake.state.files.keys()].some((path) => path.includes(".steal-"))).toBe(false);
  });
});

describe("acquireLock · 坏锁体按'不可解析'口径处理", () => {
  // 坏载荷只有一条陈旧窗口（STALE_UNPARSABLE 5s）：窗口内是"活着的锁"，
  // 守卫放错方向会把坏锁当活锁（永远抢不走）或当新锁等满 120s。
  it.each([
    ["pid 负数", payloadOf(NOW, { pid: -5 })],
    ["pid 非整数", payloadOf(NOW, { pid: 1.5 })],
    ["pid 是字符串", payloadOf(NOW, { pid: "7" })],
    ["nonce 空串", payloadOf(NOW, { nonce: "" })],
    ["nonce 非字符串", payloadOf(NOW, { nonce: 1 })],
    ["at 非数字", payloadOf(NOW, { at: "x" })],
    ["JSON 标量", "5"],
    ["JSON null", "null"],
  ])("should treat a young malformed lock (%s) as held, not stealable", async (_label, content) => {
    const local = fixedClock(NOW);
    const sleep = recordingSleep(local);
    const fake = seeded(content);
    fake.state.mtimes.set(LOCK_PATH, NOW - 1_000);

    const code = await codeOfAsync(() =>
      acquireLock({ path: LOCK_PATH, timeoutMs: 0 }, depsOf(fake.port, local.clock, sleep.sleep)),
    );

    expect(code).toBe("locked");
  });

  it("should take over a malformed lock once past the unparsable window", async () => {
    const fake = seeded('{"pid":"x","nonce":1,"at":"y"}');
    fake.state.mtimes.set(LOCK_PATH, NOW - 5_001);
    const handle = await acquireLock({ path: LOCK_PATH, timeoutMs: 0 }, rigged(fake).deps);

    expect(fake.textAt(LOCK_PATH)).not.toBe('{"pid":"x","nonce":1,"at":"y"}');
    await handle.release();
  });

  it("should keep a malformed lock still inside the unparsable window", async () => {
    const local = fixedClock(NOW);
    const sleep = recordingSleep(local);
    const fake = seeded('{"pid":"x","nonce":1,"at":"y"}');
    fake.state.mtimes.set(LOCK_PATH, NOW - 5_000);

    const code = await codeOfAsync(() =>
      acquireLock({ path: LOCK_PATH, timeoutMs: 0 }, depsOf(fake.port, local.clock, sleep.sleep)),
    );

    expect(code).toBe("locked");
  });

  it("should take over a young lock whose owner pid is already dead", async () => {
    // pid 死透了就没有窗口期可谈：立刻接管，不等 120s 活锁窗口。
    const fake = seeded(payloadOf(NOW, { pid: 2_147_400_000 }));
    fake.state.mtimes.set(LOCK_PATH, NOW - 1_000);
    const handle = await acquireLock({ path: LOCK_PATH, timeoutMs: 0 }, rigged(fake).deps);

    expect(fake.state.files.has(LOCK_PATH)).toBe(true);
    await handle.release();
  });
});

describe("acquireLock · 超时与报文", () => {
  it("should name the wait budget and the path in the timeout message", async () => {
    const fake = seeded(payloadOf(NOW));
    fake.state.mtimes.set(LOCK_PATH, NOW);
    const error = await acquireLock({ path: LOCK_PATH, timeoutMs: 3 }, rigged(fake).deps).then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(HrError);
    expect(Reflect.get(Object(error), "code")).toBe("locked");
    expect(Reflect.get(Object(error), "message")).toContain("3ms");
    expect(Reflect.get(Object(error), "message")).toContain(LOCK_PATH);
  });
});
