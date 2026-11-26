// 这层管：原子写两道父目录复核之间的竞态窗口与 writeDocGrant 的并发合表；
// 换链用假 fs 的 lstat 钩子注入，锁排他只信真 fs 的 open(wx)。

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TMP_PREFIX, writeAtomic } from "../../src/io/atomic";
import { encodeUtf8 } from "../../src/io/bytes";
import { nodePatchDeps } from "../../src/io/node-fs";
import { resolveTarget } from "../../src/io/paths";
import { readDocGrant, writeDocGrant } from "../../src/io/permissions";
import {
  codeOfAsync,
  depsOf,
  fakeFs,
  fixedClock,
  realDirOf,
  recordingSleep,
  withWorkspace,
} from "./harness";

const WORKSPACE = "/ws";
const DOC = `${WORKSPACE}/a.html`;
const DEAD_PID = 999_999;
const tmpName = (pid: number, rest: string): string =>
  `${WORKSPACE}/${TMP_PREFIX}${String(pid)}.0123456789ab.${rest}`;

const depsAt = (fake: ReturnType<typeof fakeFs>): ReturnType<typeof depsOf> => {
  const clock = fixedClock(0);
  return depsOf(fake.port, clock.clock, recordingSleep(clock).sleep);
};

describe("writeAtomic · 两次父目录复核之间的换链", () => {
  it("should abort the landing when the parent is retargeted outside mid-write", async () => {
    // 复核顺序：assertParentInside → removeStaleTmp → assertTargetNotLink → assertParentInside。
    // removeStaleTmp 对旧 tmp 的 lstat 是两道复核之间唯一的 fs 面——借它把父目录换成外链，
    // 第二道复核必须拦下，writeFileAtomic 不能发生。
    const stale = tmpName(DEAD_PID, "a.html");
    const fake = fakeFs({ [DOC]: "old", [stale]: "half" });
    fake.state.dirs.add("/outside");
    fake.once(
      "lstat",
      (path) => path === stale,
      () => {
        fake.state.links.set(WORKSPACE, "/outside");
      },
    );

    const code = await codeOfAsync(() =>
      writeAtomic({ path: DOC, workspace: WORKSPACE, data: encodeUtf8("new") }, depsAt(fake)),
    );

    expect(code).toBe("path_outside_workspace");
    expect(fake.state.files.get(DOC)).toEqual(encodeUtf8("old"));
    expect(fake.state.log.some((line) => line.startsWith("writeFileAtomic:"))).toBe(false);
  });

  it("should not leak tmp or partially-written files after a refused landing", async () => {
    // 拒绝发生在假 fs 的一步落盘之前：目录里除了原文件与（已回收的）旧 tmp 痕迹外，
    // 不能多出任何 `.hr-tmp` / 数字后缀残留——真盘上这就是"半写文件"。
    const fake = fakeFs({ [DOC]: "old" });
    fake.state.dirs.delete(WORKSPACE);
    fake.state.dirs.add("/elsewhere");

    await codeOfAsync(() =>
      writeAtomic({ path: DOC, workspace: WORKSPACE, data: encodeUtf8("new") }, depsAt(fake)),
    );

    const residue = [...fake.state.files.keys()].filter(
      (name) => name.includes(TMP_PREFIX) || /\.\d+$/u.test(name),
    );
    expect(residue).toEqual([]);
    expect(fake.state.files.get(DOC)).toEqual(encodeUtf8("old"));
  });
});

describe("writeDocGrant · 并发合表", () => {
  it("should keep both grants when two writeDocGrant calls race on the shared table", async () => {
    await withWorkspace(async (dir) => {
      const workspace = await realDirOf(dir);
      // resolveTarget 要目标存在：先落两个外来文档——授权按路径记，两篇各一条。
      await writeFile(join(workspace, "a.html"), "seed");
      await writeFile(join(workspace, "b.html"), "seed");
      const targetA = await resolveTarget({ workspace, file: "a.html" }, nodePatchDeps.fs);
      const targetB = await resolveTarget({ workspace, file: "b.html" }, nodePatchDeps.fs);
      const bytes = encodeUtf8("irrelevant");

      // trust.lock 串行化读-改-写：两份授权都要落盘，而不是后者把整表覆盖回 {}。
      await Promise.all([
        writeDocGrant(
          { target: targetA, grant: { scripts: true, network: false } },
          nodePatchDeps,
        ),
        writeDocGrant(
          { target: targetB, grant: { scripts: false, network: true } },
          nodePatchDeps,
        ),
      ]);

      expect(await readDocGrant({ target: targetA, bytes }, nodePatchDeps)).toEqual({
        scripts: true,
        network: false,
      });
      expect(await readDocGrant({ target: targetB, bytes }, nodePatchDeps)).toEqual({
        scripts: false,
        network: true,
      });
      const table: unknown = JSON.parse(
        await readFile(join(workspace, ".hreader", "trust.json"), "utf8"),
      );
      expect(Object.keys(table as Record<string, unknown>).sort()).toEqual(
        ["a.html", "b.html"].sort(),
      );
    });
  });
});
