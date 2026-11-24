// 这层管：纯层与 io 里那些"小到没人为它单独写文件"的导出函数，逐分支打满；
// 只 import 被测模块，不经过 patchFile/undo 等上层（纯层隔离）。

import { describe, expect, it } from "vitest";

import { HrError } from "../../src/hr-error";
import { removeStaleTmp } from "../../src/io/atomic";
import { readBytes } from "../../src/io/bytes";
import { acquireLock } from "../../src/io/lock";
import { decodeUtf8, encodeUtf8 } from "../../src/io/bytes";
import {
  attributeValueLoose,
  hasAttribute,
  hasAttributeLoose,
} from "../../src/ops/patch-node/attrs";
import { isProcessAlive } from "../../src/io/process";
import { codeOfAsync, depsOf, fakeFs, fixedClock, recordingSleep, systemError } from "./harness";

const DEAD_PID = 999_999;

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error: unknown) {
    const code: unknown = error instanceof HrError ? error.code : undefined;
    return typeof code === "string" ? code : "no_code";
  }
  return "no_throw";
};

const ATTRS = [
  ["data-hr-id", "p2"],
  ["attributeName", "onload"],
  ["Hidden", "yes"],
] as const;

describe("attrs · 大小写敏感的精确匹配与宽松匹配", () => {
  it("should match exactly for hasAttribute and case-insensitively for the loose variants", () => {
    expect(hasAttribute(ATTRS, "data-hr-id")).toBe(true);
    expect(hasAttribute(ATTRS, "DATA-HR-ID")).toBe(false);
    expect(hasAttributeLoose(ATTRS, "ATTRIBUTENAME")).toBe(true);
    expect(hasAttributeLoose(ATTRS, "attributeName")).toBe(true);
    expect(hasAttributeLoose(ATTRS, "missing")).toBe(false);
    expect(attributeValueLoose(ATTRS, "ATTRIBUTENAME")).toBe("onload");
    expect(attributeValueLoose(ATTRS, "hidden")).toBe("yes");
    expect(attributeValueLoose(ATTRS, "missing")).toBeUndefined();
    expect(attributeValueLoose([], "hidden")).toBeUndefined();
  });
});

describe("bytes · 严格 UTF-8 与 BOM 保留", () => {
  it("should keep a BOM in the text and round-trip it", () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x61]);
    expect(decodeUtf8(bom, "/ws/a.html")).toBe("\uFEFFa");
    expect(Array.from(encodeUtf8(decodeUtf8(bom, "/ws/a.html")))).toEqual([0xef, 0xbb, 0xbf, 0x61]);
  });

  it("should reject invalid UTF-8 with invalid_utf8 instead of substituting U+FFFD", () => {
    expect(codeOf(() => decodeUtf8(new Uint8Array([0xff, 0xfe]), "/ws/a.html"))).toBe(
      "invalid_utf8",
    );
    const error = (() => {
      try {
        decodeUtf8(new Uint8Array([0xff]), "/ws/a.html");
        return undefined;
      } catch (thrown: unknown) {
        return thrown;
      }
    })();
    const message: unknown = Reflect.get(Object(error), "message");
    expect(String(message)).toContain("/ws/a.html");
  });
});

describe("process · pid 存活探测", () => {
  it("should treat non-positive and non-integer pids as dead without probing", () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(1.5)).toBe(false);
    expect(isProcessAlive(process.pid)).toBe(true);
  });
});

const NOW = 1_700_000_000_000;
const dirs = ["/ws", "/ws/.hreader", "/ws/.hreader/locks"];

describe("io 端口的失败翻译（走假 fs，不碰真盘）", () => {
  it("should map a read failure to io_failure without inventing bytes", async () => {
    const fake = fakeFs({ "/ws/a.html": "x" });
    fake.fail("readFile", systemError("EACCES"));

    expect(await codeOfAsync(() => readBytes(fake.port, "/ws/a.html"))).toBe("io_failure");
  });

  it("should keep a tmp whose lstat fails (cannot prove the owner is dead)", async () => {
    const tmp = `/ws/.hr-tmp.${String(DEAD_PID)}.0123456789ab.a.html`;
    const fake = fakeFs({ "/ws/a.html": "x", [tmp]: "half" });
    for (const dir of dirs) fake.state.dirs.add(dir);
    fake.fail("lstat", systemError("EPERM"), (path) => path === tmp);

    await removeStaleTmp(
      depsOf(fake.port, fixedClock(NOW).clock, recordingSleep().sleep),
      "/ws",
      "a.html",
    );

    expect(fake.state.files.has(tmp)).toBe(true);
    expect(fake.state.files.has("/ws/a.html")).toBe(true);
  });
});

describe("io 端口的失败翻译（续）", () => {
  // 这条曾经把"数据丢失缺陷"写成了期望：`ageOf()` 在 lstat 失败时返回 MAX_SAFE_INTEGER，
  // 于是一个刚创建、只是暂时读不动的锁会被判成陈旧并抢走 —— 两个写者同时持锁 → 丢写。
  // 实现已改为"不可读 = 年龄 0 = 不陈旧"；断言随之翻转。
  it("should keep an unreadable lock and time out instead of stealing it", async () => {
    const lock = "/ws/.hreader/locks/lock.lock";
    const fake = fakeFs({ "/ws/a.html": "x", [lock]: "{broken" });
    for (const dir of dirs) fake.state.dirs.add(dir);
    fake.fail("lstat", systemError("EIO"), (path) => path === lock);

    // 假时钟 + 假 sleep 绑定推进：等到 deadline 就抛，不会真等也不会忙转。
    const local = fixedClock(NOW);
    const attempt = acquireLock(
      { path: lock, timeoutMs: 20 },
      depsOf(fake.port, local.clock, recordingSleep(local).sleep),
    );

    await expect(attempt).rejects.toMatchObject({ code: "locked" });
    await expect(attempt).rejects.toThrow(/锁/u);
    // 原文件一个字节都不许被动过：抢锁会覆盖 nonce，等于把持有者的写保护抹掉。
    expect(fake.textAt(lock)).toBe("{broken");
  });
});
