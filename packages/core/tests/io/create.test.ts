// This layer: the "create only if absent" primitives (io/create.ts): success/EEXIST/IO-failure semantics
// on both the link and open paths, mid-batch reclaim, and tmp residue shape. The fake fs injects precise errors.

import { describe, expect, it } from "vitest";

import { encodeUtf8 } from "../../src/io/bytes";
import { createNewFile, createNewFiles } from "../../src/io/create";
import { resolveNewTarget } from "../../src/io/paths";
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

/** The no-`link`-port fallback shape: exclusive create via `open`. Wrapped explicitly — the real situation of "the port happens not to implement link". */
const withoutLink = (port: FileSystem): FileSystem => ({
  readFile: (path) => port.readFile(path),
  writeFile: (path, data) => port.writeFile(path, data),
  rename: (from, to) => port.rename(from, to),
  unlink: (path) => port.unlink(path),
  mkdir: (path) => port.mkdir(path),
  rmdir: (path) => port.rmdir(path),
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

describe("createNewFile · link path", () => {
  it("should create the target via tmp + link and leave no residue", async () => {
    const fake = fakeFs({ "/ws/keep.html": "x" });
    await createNewFile(TARGET, encodeUtf8("fresh"), depsAt(fake), "/ws");

    expect(fake.textAt(TARGET)).toBe("fresh");
    expect(residueNames(fake)).toHaveLength(0);
    expect(fake.state.log.some((line) => line.startsWith("link:"))).toBe(true);
  });

  it("should report file_exists and not touch the existing target", async () => {
    const fake = fakeFs({ [TARGET]: "mine" });
    expect(
      await codeOfAsync(() => createNewFile(TARGET, encodeUtf8("x"), depsAt(fake), "/ws")),
    ).toBe("file_exists");
    expect(fake.textAt(TARGET)).toBe("mine");
    expect(residueNames(fake)).toHaveLength(0);
  });

  it("should map a non-EEXIST link failure to io_failure and clean the tmp", async () => {
    const fake = fakeFs({ "/ws/keep.html": "x" });
    fake.fail("link", systemError("EPERM"));

    expect(
      await codeOfAsync(() => createNewFile(TARGET, encodeUtf8("x"), depsAt(fake), "/ws")),
    ).toBe("io_failure");
    expect(residueNames(fake)).toHaveLength(0);
  });

  it("should map a staging failure to io_failure without touching the target", async () => {
    const fake = fakeFs({ "/ws/keep.html": "x" });
    fake.fail("writeFileAtomic", systemError("ENOSPC"));

    expect(
      await codeOfAsync(() => createNewFile(TARGET, encodeUtf8("x"), depsAt(fake), "/ws")),
    ).toBe("io_failure");
    expect(fake.state.files.has(TARGET)).toBe(false);
  });
});

describe("createNewFile · parent-swap recheck", () => {
  it("should refuse to land when the parent dir was swapped for an outside link after resolve", async () => {
    const fake = fakeFs({ "/ws/keep.html": "x", "/outside/escape.html": "e" });
    const resolved = await resolveNewTarget({ workspace: "/ws", file: "new.html" }, fake.port);

    // Mid-flight swap: the checked parent is now a link that resolves outside the workspace.
    fake.state.links.set("/ws", "/outside");

    expect(
      await codeOfAsync(() =>
        createNewFile(resolved.absolute, encodeUtf8("x"), depsAt(fake), resolved.workspace),
      ),
    ).toBe("path_outside_workspace");
    expect(fake.state.files.has(resolved.absolute)).toBe(false);
    expect(fake.state.files.has("/outside/new.html")).toBe(false);
    expect(residueNames(fake)).toHaveLength(0);
  });

  it("should not even stage the tmp write when the parent dir has escaped", async () => {
    const fake = fakeFs({ "/ws/keep.html": "x", "/outside/escape.html": "e" });
    const resolved = await resolveNewTarget({ workspace: "/ws", file: "new.html" }, fake.port);
    fake.state.links.set("/ws", "/outside");

    expect(
      await codeOfAsync(() =>
        createNewFile(resolved.absolute, encodeUtf8("x"), depsAt(fake), resolved.workspace),
      ),
    ).toBe("path_outside_workspace");
    // The boundary check runs before staging: no write op is attempted at all.
    expect(fake.state.log.some((line) => line.startsWith("writeFileAtomic:"))).toBe(false);
  });

  it("should apply the same recheck on the open fallback path", async () => {
    const fake = fakeFs({ "/ws/keep.html": "x", "/outside/escape.html": "e" });
    const resolved = await resolveNewTarget({ workspace: "/ws", file: "new.html" }, fake.port);
    fake.state.links.set("/ws", "/outside");

    expect(
      await codeOfAsync(() =>
        createNewFile(resolved.absolute, encodeUtf8("x"), depsAtNoLink(fake), resolved.workspace),
      ),
    ).toBe("path_outside_workspace");
    expect(fake.state.files.has(resolved.absolute)).toBe(false);
  });
});

describe("createNewFile · open fallback (no link port)", () => {
  it("should create the target through the exclusive open fallback", async () => {
    const fake = fakeFs({ "/ws/keep.html": "x" });
    await createNewFile(TARGET, encodeUtf8("fresh"), depsAtNoLink(fake), "/ws");

    expect(fake.textAt(TARGET)).toBe("fresh");
    expect(fake.state.log.some((line) => line.startsWith("link:"))).toBe(false);
  });

  it("should report file_exists when open hits an existing target", async () => {
    const fake = fakeFs({ [TARGET]: "mine" });
    expect(
      await codeOfAsync(() => createNewFile(TARGET, encodeUtf8("x"), depsAtNoLink(fake), "/ws")),
    ).toBe("file_exists");
    expect(fake.textAt(TARGET)).toBe("mine");
  });

  it("should remove the half-written file when the write fails", async () => {
    const fake = fakeFs({ "/ws/keep.html": "x" });
    fake.fail("handleWrite", systemError("EIO"));

    expect(
      await codeOfAsync(() => createNewFile(TARGET, encodeUtf8("x"), depsAtNoLink(fake), "/ws")),
    ).toBe("io_failure");
    expect(fake.state.files.has(TARGET)).toBe(false);
  });

  it("should map a non-EEXIST open failure to io_failure", async () => {
    const fake = fakeFs({ "/ws/keep.html": "x" });
    fake.fail("open", systemError("EPERM"));

    expect(
      await codeOfAsync(() => createNewFile(TARGET, encodeUtf8("x"), depsAtNoLink(fake), "/ws")),
    ).toBe("io_failure");
  });
});

describe("createNewFiles · batch", () => {
  it("should create every file in order", async () => {
    const fake = fakeFs({ "/ws/keep.html": "x" });
    await createNewFiles(
      [
        { path: "/ws/a.html", data: encodeUtf8("a") },
        { path: "/ws/b.html", data: encodeUtf8("b") },
      ],
      depsAt(fake),
      "/ws",
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
          "/ws",
        ),
      ),
    ).toBe("file_exists");

    expect(fake.state.files.has("/ws/a.html")).toBe(false);
    expect(fake.textAt("/ws/b.html")).toBe("existing");
  });
});
