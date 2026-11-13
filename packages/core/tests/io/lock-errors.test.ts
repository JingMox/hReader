// 这层管：锁体结构非法、读锁 ENOENT/EACCES 的分类（"结构坏"按不可解析、只有 ENOENT 才算不存在）。

import { describe, expect, it } from "vitest";

import { acquireLock } from "../../src/io/lock";
import { depsOf, fakeFs, fixedClock, recordingSleep, systemError } from "./harness";

const NOW = Date.parse("2026-03-04T05:06:07.008Z");

describe('acquireLock · 锁体结构非法时按"不可解析"处理（5s 后接管）', () => {
  it.each([
    ["null", "null"],
    ["number", "42"],
    ["pid 0", JSON.stringify({ pid: 0, nonce: "a", at: 1 })],
    ["pid 非整数", JSON.stringify({ pid: 1.5, nonce: "a", at: 1 })],
    ["nonce 空串", JSON.stringify({ pid: 1, nonce: "", at: 1 })],
    ["nonce 非字符串", JSON.stringify({ pid: 1, nonce: 5, at: 1 })],
    ["at 非有限数", JSON.stringify({ pid: 1, nonce: "a", at: "x" })],
  ])("should take over a lock whose payload is %s", async (_label, content) => {
    const lock = "/ws/.hreader/locks/lock.lock";
    const fake = fakeFs({ "/ws/a.html": "x", [lock]: content });
    for (const dir of ["/ws", "/ws/.hreader", "/ws/.hreader/locks"]) fake.state.dirs.add(dir);
    fake.state.mtimes.set(lock, NOW - 10_000);

    const handle = await acquireLock(
      { path: lock, timeoutMs: 2000 },
      depsOf(fake.port, fixedClock(NOW).clock, recordingSleep(fixedClock(NOW)).sleep),
    );

    const written: unknown = JSON.parse(fake.textAt(lock));
    expect(Reflect.get(Object(written), "pid")).toBe(process.pid);
    await handle.release();
    expect(fake.state.files.has(lock)).toBe(false);
  });
});

describe("acquireLock · 读锁时的 ENOENT", () => {
  it("should treat a lock that disappears between lstat and read as absent (ENOENT)", async () => {
    const lock = "/ws/.hreader/locks/lock.lock";
    const fake = fakeFs({
      "/ws/a.html": "x",
      [lock]: JSON.stringify({ pid: 999_999, nonce: "gone", at: 1 }),
    });
    for (const dir of ["/ws", "/ws/.hreader", "/ws/.hreader/locks"]) fake.state.dirs.add(dir);
    fake.once(
      "lstat",
      (path) => path === lock,
      () => fake.state.files.delete(lock),
    );

    const handle = await acquireLock(
      { path: lock, timeoutMs: 2000 },
      depsOf(fake.port, fixedClock(NOW).clock, recordingSleep(fixedClock(NOW)).sleep),
    );

    expect(fake.textAt(lock)).toContain(String(process.pid));
    await handle.release();
  });
});

describe("acquireLock · 读锁时的 ENOENT（open 与 read 之间被删）", () => {
  it("should treat an ENOENT on read as 'lock gone' and retry until the budget ends", async () => {
    const lock = "/ws/.hreader/locks/lock.lock";
    const fake = fakeFs({
      "/ws/a.html": "x",
      [lock]: JSON.stringify({ pid: process.pid, nonce: "alive", at: NOW }),
    });
    for (const dir of ["/ws", "/ws/.hreader", "/ws/.hreader/locks"]) fake.state.dirs.add(dir);
    fake.state.mtimes.set(lock, NOW);
    fake.fail("readFile", systemError("ENOENT"), (path) => path === lock);
    const clock = fixedClock(NOW);

    await expect(
      acquireLock(
        { path: lock, timeoutMs: 2000 },
        depsOf(fake.port, clock.clock, recordingSleep(clock).sleep),
      ),
    ).rejects.toMatchObject({ code: "locked" });
    expect(fake.textAt(lock)).toContain('"nonce":"alive"');
  });
});

describe("acquireLock · 读锁遇到非 ENOENT 故障要硬失败", () => {
  it("should surface EACCES as io_failure instead of stealing the lock", async () => {
    const lock = "/ws/.hreader/locks/lock.lock";
    const fake = fakeFs({
      "/ws/a.html": "x",
      [lock]: JSON.stringify({ pid: 1, nonce: "a", at: 1 }),
    });
    for (const dir of ["/ws", "/ws/.hreader", "/ws/.hreader/locks"]) fake.state.dirs.add(dir);
    fake.fail("readFile", systemError("EACCES"), (path) => path === lock);

    await expect(
      acquireLock(
        { path: lock, timeoutMs: 2000 },
        depsOf(fake.port, fixedClock(NOW).clock, recordingSleep(fixedClock(NOW)).sleep),
      ),
    ).rejects.toMatchObject({ code: "io_failure" });
    expect(fake.textAt(lock)).toContain('"nonce":"a"');
  });
});
