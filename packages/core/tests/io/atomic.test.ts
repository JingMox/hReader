// 这层管：原子写编排的失败矩阵（落盘调用失败、原文件不动、cause 保留）与两类遗留 tmp 识别；用假 fs 精确控错。

import { describe, expect, it } from "vitest";

import { removeStaleTmp, TMP_PREFIX, writeAtomic } from "../../src/io/atomic";
import { encodeUtf8 } from "../../src/io/bytes";
import {
  codeOfAsync,
  depsOf,
  fakeFs,
  fixedClock,
  recordingSleep,
  systemError,
  type FakeState,
} from "./harness";

const NOW = Date.parse("2026-03-04T05:06:07.008Z");
const DOC = "/ws/a.html";
const DEAD_PID = 999_999;
const tmpName = (pid: number, rest: string): string =>
  `/ws/${TMP_PREFIX}${String(pid)}.0123456789ab.${rest}`;
const decode = (state: FakeState, path: string): string =>
  new TextDecoder().decode(state.files.get(path) ?? new Uint8Array());

const depsAt = (fake: ReturnType<typeof fakeFs>): ReturnType<typeof depsOf> => {
  const clock = fixedClock(NOW);
  return depsOf(fake.port, clock.clock, recordingSleep(clock).sleep);
};

const writeOn = (fake: ReturnType<typeof fakeFs>, data: string): Promise<void> =>
  writeAtomic({ path: DOC, workspace: "/ws", data: encodeUtf8(data) }, depsAt(fake));

const failureOf = async (run: () => Promise<unknown>): Promise<{ code: string; cause: string }> => {
  try {
    await run();
  } catch (error: unknown) {
    const code: unknown = Reflect.get(Object(error), "code");
    const cause: unknown = Reflect.get(Object(error), "cause");
    return {
      code: typeof code === "string" ? code : "no_code",
      cause: String(Reflect.get(Object(cause), "code") ?? "no_cause"),
    };
  }
  return { code: "no_throw", cause: "no_cause" };
};

describe("writeAtomic · 成功与落盘失败", () => {
  it("should delegate the landing to the port and sweep dead-pid tmp first", async () => {
    const dead = tmpName(DEAD_PID, "a.html");
    const fake = fakeFs({ [DOC]: "old", [dead]: "half" });
    await writeOn(fake, "new");

    expect(decode(fake.state, DOC)).toBe("new");
    expect(fake.state.files.has(dead)).toBe(false);
    expect(fake.state.log).toContain(`writeFileAtomic:${DOC}`);
  });

  it("should keep the original when the atomic write fails", async () => {
    const fake = fakeFs({ [DOC]: "old" });
    fake.fail("writeFileAtomic", systemError("EXDEV"));

    expect(await failureOf(() => writeOn(fake, "new"))).toEqual({
      code: "io_failure",
      cause: "EXDEV",
    });
    expect(decode(fake.state, DOC)).toBe("old");
  });
});

describe("writeAtomic · 前置步骤失败", () => {
  it("should refuse to write through a parent that left the workspace", async () => {
    const fake = fakeFs({ [DOC]: "old" });
    fake.state.dirs.delete("/ws");
    fake.state.dirs.add("/elsewhere");

    const code = await codeOfAsync(() => writeOn(fake, "new"));

    expect(code).toBe("path_outside_workspace");
    expect(decode(fake.state, DOC)).toBe("old");
    expect(fake.state.log.some((line) => line.startsWith("writeFileAtomic:"))).toBe(false);
  });

  it("should fail before touching the target when the directory cannot be read", async () => {
    const fake = fakeFs({ [DOC]: "old" });
    fake.fail("readdir", systemError("EACCES"));

    expect(await codeOfAsync(() => writeOn(fake, "new"))).toBe("io_failure");
    expect(decode(fake.state, DOC)).toBe("old");
    expect(fake.state.log.some((line) => line.startsWith("writeFileAtomic:"))).toBe(false);
  });
});

describe("writeAtomic · 只读目标", () => {
  it("should refuse to rewrite a file whose owner write bit is off", async () => {
    // tmp + rename 会绕过目标自己的权限位：444 的文件照样被改写，用户以为设了只读就安全。
    const fake = fakeFs({ [DOC]: "old" });
    const deps = depsAt(fake);
    const readonlyDeps = {
      ...deps,
      fs: {
        ...deps.fs,
        lstat: () =>
          Promise.resolve({
            isFile: () => true,
            isSymbolicLink: () => false,
            mtimeMs: NOW,
            mode: 0o444,
          }),
      },
    };

    const error: unknown = await writeAtomic(
      { path: DOC, workspace: "/ws", data: encodeUtf8("new") },
      readonlyDeps,
    ).catch((thrown: unknown) => thrown);

    expect(Reflect.get(Object(error), "code")).toBe("io_failure");
    expect(String(Reflect.get(Object(error), "message"))).toContain("文件是只读的");
    expect(decode(fake.state, DOC)).toBe("old");
  });
});

describe("removeStaleTmp · 旧版 .hr-tmp 只动自己且已死的", () => {
  it("should delete a dead-pid tmp and keep foreign or live files", async () => {
    const dead = tmpName(DEAD_PID, "a.html");
    const live = tmpName(process.pid, "a.html");
    const fake = fakeFs({
      "/ws/a.html": "x",
      [dead]: "1",
      [live]: "live",
      "/ws/keep.tmp": "keep",
      "/ws/notes.txt": "notes",
    });
    await removeStaleTmp(depsAt(fake), "/ws", "a.html");

    expect(fake.state.files.has(dead)).toBe(false);
    expect(fake.state.files.has(live)).toBe(true);
    expect(fake.state.files.has("/ws/keep.tmp")).toBe(true);
    expect(fake.state.files.has("/ws/notes.txt")).toBe(true);
  });

  it("should take over an aged tmp even when its pid is alive", async () => {
    const aged = tmpName(process.pid, "a.html");
    const fresh = tmpName(process.pid, "b.html");
    const fake = fakeFs({ "/ws/a.html": "x", [aged]: "old", [fresh]: "new" });
    fake.state.mtimes.set(aged, NOW - 10 * 60_000);
    fake.state.mtimes.set(fresh, NOW);

    await removeStaleTmp(depsAt(fake), "/ws", "a.html");

    expect(fake.state.files.has(aged)).toBe(false);
    expect(fake.state.files.has(fresh)).toBe(true);
  });
});

describe("removeStaleTmp · write-file-atomic 的数字残留", () => {
  it("should sweep an aged same-name residue but keep fresh or look-alike files", async () => {
    const aged = "/ws/a.html.1234567";
    const fresh = "/ws/a.html.7654321";
    const lookalike = "/ws/a.html.2024";
    const other = "/ws/b.html.9999999";
    const fake = fakeFs({
      "/ws/a.html": "x",
      [aged]: "half",
      [fresh]: "half",
      [lookalike]: "user file",
      [other]: "other file's residue",
    });
    fake.state.mtimes.set(aged, NOW - 10 * 60_000);
    fake.state.mtimes.set(fresh, NOW);
    fake.state.mtimes.set(lookalike, NOW - 10 * 60_000);
    fake.state.mtimes.set(other, NOW - 10 * 60_000);

    await removeStaleTmp(depsAt(fake), "/ws", "a.html");

    expect(fake.state.files.has(aged)).toBe(false);
    expect(fake.state.files.has(fresh)).toBe(true);
    // 数字不足 6 位的不算 tmp；别的目标的残留只在该目标写入时才回收。
    expect(fake.state.files.has(lookalike)).toBe(true);
    expect(fake.state.files.has(other)).toBe(true);
  });

  it("should surface a missing directory instead of inventing an error code", async () => {
    const fake = fakeFs({ "/ws/a.html": "x" });

    expect(await codeOfAsync(() => removeStaleTmp(depsAt(fake), "/nope", "a.html"))).toBe("ENOENT");
  });
});

describe("removeStaleTmp · 删不动不致命", () => {
  it("should keep sweeping when one tmp cannot be deleted", async () => {
    // 清扫是顺手活：一个残留删不掉不能把整个写流程弄死。
    const dead = tmpName(DEAD_PID, "a.html");
    const other = tmpName(DEAD_PID, "b.html");
    const fake = fakeFs({ "/ws/a.html": "x", [dead]: "half", [other]: "half" });
    fake.fail("unlink", systemError("EPERM"), (path) => path === dead);

    await removeStaleTmp(depsAt(fake), "/ws", "a.html");

    expect(fake.state.files.has(dead)).toBe(true);
    expect(fake.state.files.has(other)).toBe(false);
  });
});

describe("writeAtomic · 父目录与落盘目标的安全复核", () => {
  it("should refuse when the parent realpath leaves the workspace", async () => {
    const fake = fakeFs({ "/outside/a.html": "keep", "/ws/a.html": "old" });
    fake.state.dirs.add("/outside");
    fake.state.dirs.add("/ws/sub");
    fake.state.links.set("/ws/sub", "/outside");

    const code = await codeOfAsync(() =>
      writeAtomic(
        { path: "/ws/sub/a.html", workspace: "/ws", data: encodeUtf8("new") },
        depsAt(fake),
      ),
    );

    expect(code).toBe("path_outside_workspace");
    expect(decode(fake.state, "/outside/a.html")).toBe("keep");
    expect(decode(fake.state, "/ws/a.html")).toBe("old");
  });

  it("should refuse to write a target that turned into a symlink", async () => {
    const fake = fakeFs({ "/ws/a.html": "old", "/outside/target": "untouched" });
    fake.state.links.set("/ws/a.html", "/outside/target");

    const code = await codeOfAsync(() => writeOn(fake, "new"));

    expect(code).toBe("path_outside_workspace");
    expect(decode(fake.state, "/outside/target")).toBe("untouched");
    expect(decode(fake.state, "/ws/a.html")).toBe("old");
    expect(fake.state.log.some((line) => line.startsWith("writeFileAtomic:"))).toBe(false);
  });
});
