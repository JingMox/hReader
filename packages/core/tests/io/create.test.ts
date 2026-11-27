// 这层管："create only if absent"原语（io/create.ts）：link 与 open 两条路径的成功/EEXIST/IO 失败语义、
// 批次中途失败的回收、tmp 残留形态。用假 fs 精确控错。

import { describe, expect, it } from "vitest";

import { encodeUtf8 } from "../../src/io/bytes";
import { createNewFile, createNewFiles } from "../../src/io/create";
import type { FileSystem, PatchDeps } from "../../src/io/ports";
import {
  codeOfAsync,
  depsOf,
  fakeFs,
  fixedClock,
  recordingSleep,
  systemError,
  type FakeFs,
} from "./harness";

const TARGET = "/ws/new.html";

const depsAt = (fake: FakeFs): PatchDeps => {
  const clock = fixedClock(0);
  return depsOf(fake.port, clock.clock, recordingSleep(clock).sleep);
};

/** 没有 `link` 端口的退路形态：走 `open` 的独占创建。显式包一层——"端口恰好没实现 link"的真实情形。 */
const withoutLink = (port: FileSystem): FileSystem => ({
  readFile: (path) => port.readFile(path),
  writeFile: (path, data) => port.writeFile(path, data),
  rename: (from, to) => port.rename(from, to),
  unlink: (path) => port.unlink(path),
  mkdir: (path) => port.mkdir(path),
  lstat: (path) => port.lstat(path),
  readdir: (path) => port.readdir(path),
  realpath: (path) => port.realpath(path),
  open: (path) => port.open(path),
  close: (file) => port.close(file),
  writeFileAtomic: (path, data) => port.writeFileAtomic(path, data),
});

const depsAtNoLink = (fake: FakeFs): PatchDeps => {
  const clock = fixedClock(0);
  return depsOf(withoutLink(fake.port), clock.clock, recordingSleep(clock).sleep);
};

const residueNames = (fake: FakeFs): string[] =>
  [...fake.state.files.keys()].filter((path) => /\.\d{6,}$/u.test(path));

describe("createNewFile · link 路径", () => {
  it("should create the target via tmp + link and leave no residue", async () => {
    const fake = fakeFs({ "/ws/keep.html": "x" });
    await createNewFile(TARGET, encodeUtf8("fresh"), depsAt(fake));

    expect(fake.textAt(TARGET)).toBe("fresh");
    expect(residueNames(fake)).toHaveLength(0);
    expect(fake.state.log.some((line) => line.startsWith("link:"))).toBe(true);
  });

  it("should report file_exists and not touch the existing target", async () => {
    const fake = fakeFs({ [TARGET]: "mine" });
    expect(await codeOfAsync(() => createNewFile(TARGET, encodeUtf8("x"), depsAt(fake)))).toBe(
      "file_exists",
    );
    expect(fake.textAt(TARGET)).toBe("mine");
    expect(residueNames(fake)).toHaveLength(0);
  });

  it("should map a non-EEXIST link failure to io_failure and clean the tmp", async () => {
    const fake = fakeFs({ "/ws/keep.html": "x" });
    fake.fail("link", systemError("EPERM"));

    expect(await codeOfAsync(() => createNewFile(TARGET, encodeUtf8("x"), depsAt(fake)))).toBe(
      "io_failure",
    );
    expect(residueNames(fake)).toHaveLength(0);
  });

  it("should map a staging failure to io_failure without touching the target", async () => {
    const fake = fakeFs({ "/ws/keep.html": "x" });
    fake.fail("writeFileAtomic", systemError("ENOSPC"));

    expect(await codeOfAsync(() => createNewFile(TARGET, encodeUtf8("x"), depsAt(fake)))).toBe(
      "io_failure",
    );
    expect(fake.state.files.has(TARGET)).toBe(false);
  });
});

describe("createNewFile · open 退路（无 link 端口）", () => {
  it("should create the target through the exclusive open fallback", async () => {
    const fake = fakeFs({ "/ws/keep.html": "x" });
    await createNewFile(TARGET, encodeUtf8("fresh"), depsAtNoLink(fake));

    expect(fake.textAt(TARGET)).toBe("fresh");
    expect(fake.state.log.some((line) => line.startsWith("link:"))).toBe(false);
  });

  it("should report file_exists when open hits an existing target", async () => {
    const fake = fakeFs({ [TARGET]: "mine" });
    expect(
      await codeOfAsync(() => createNewFile(TARGET, encodeUtf8("x"), depsAtNoLink(fake))),
    ).toBe("file_exists");
    expect(fake.textAt(TARGET)).toBe("mine");
  });

  it("should remove the half-written file when the write fails", async () => {
    const fake = fakeFs({ "/ws/keep.html": "x" });
    fake.fail("handleWrite", systemError("EIO"));

    expect(
      await codeOfAsync(() => createNewFile(TARGET, encodeUtf8("x"), depsAtNoLink(fake))),
    ).toBe("io_failure");
    expect(fake.state.files.has(TARGET)).toBe(false);
  });

  it("should map a non-EEXIST open failure to io_failure", async () => {
    const fake = fakeFs({ "/ws/keep.html": "x" });
    fake.fail("open", systemError("EPERM"));

    expect(
      await codeOfAsync(() => createNewFile(TARGET, encodeUtf8("x"), depsAtNoLink(fake))),
    ).toBe("io_failure");
  });
});

describe("createNewFiles · 批次", () => {
  it("should create every file in order", async () => {
    const fake = fakeFs({ "/ws/keep.html": "x" });
    await createNewFiles(
      [
        { path: "/ws/a.html", data: encodeUtf8("a") },
        { path: "/ws/b.html", data: encodeUtf8("b") },
      ],
      depsAt(fake),
    );

    expect(fake.textAt("/ws/a.html")).toBe("a");
    expect(fake.textAt("/ws/b.html")).toBe("b");
  });

  it("should roll back files created before a mid-batch failure", async () => {
    const fake = fakeFs({ "/ws/b.html": "existing" });
    expect(
      await codeOfAsync(() =>
        createNewFiles(
          [
            { path: "/ws/a.html", data: encodeUtf8("a") },
            { path: "/ws/b.html", data: encodeUtf8("b") },
          ],
          depsAt(fake),
        ),
      ),
    ).toBe("file_exists");

    expect(fake.state.files.has("/ws/a.html")).toBe(false);
    expect(fake.textAt("/ws/b.html")).toBe("existing");
  });
});
