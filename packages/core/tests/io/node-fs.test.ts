// 这层管：node-fs 端口的真实行为（wx 独占、sync、关闭幂等）与默认 deps 的形状；不测业务编排。

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { encodeUtf8 } from "../../src/io/bytes";
import { nodePatchDeps } from "../../src/io/node-fs";
import type { OpenFile } from "../../src/io/ports";
import {
  codeOfAsync,
  readBytesAt,
  readTextAt,
  realDirOf,
  sha1Of,
  symlinkAt,
  withWorkspace,
  writeTextAt,
} from "./harness";

const fsApi = nodePatchDeps.fs;

describe("nodePatchDeps · 默认依赖", () => {
  it("should expose the full port and a real clock and sleep", async () => {
    expect(Object.keys(fsApi).sort()).toEqual([
      "chmod",
      "close",
      "lstat",
      "mkdir",
      "open",
      "readFile",
      "readdir",
      "realpath",
      "rename",
      "unlink",
      "writeFile",
    ]);
    const now = nodePatchDeps.clock.now();
    expect(now instanceof Date).toBe(true);
    expect(Math.abs(Date.now() - now.getTime())).toBeLessThan(5_000);
    await expect(nodePatchDeps.sleep(1)).resolves.toBeUndefined();
  });
});

describe("node-fs · 独占打开", () => {
  it("should create, fsync and close a file exactly once", async () => {
    await withWorkspace(async (dir) => {
      const file = join(dir, "a.html");
      const handle = await fsApi.open(file, "wx");
      await handle.write(encodeUtf8("正文"));
      await handle.sync();
      await fsApi.close(handle);

      expect(await readTextAt(file)).toBe("正文");
      expect(await codeOfAsync(() => fsApi.open(file, "wx"))).toBe("EEXIST");
    });
  });

  it("should make close idempotent and ignore foreign handles", async () => {
    await withWorkspace(async (dir) => {
      const handle = await fsApi.open(join(dir, "a.html"), "wx");
      const foreign: OpenFile = {
        write: () => Promise.resolve(),
        sync: () => Promise.resolve(),
      };
      await fsApi.close(handle);
      await expect(fsApi.close(handle)).resolves.toBeUndefined();
      await expect(fsApi.close(foreign)).resolves.toBeUndefined();
    });
  });
});

describe("node-fs · 其余端口", () => {
  it("should pass through writeFile/readFile/rename/unlink/mkdir/lstat/readdir/realpath", async () => {
    await withWorkspace(async (dir) => {
      const nested = join(dir, "a", "b");
      await fsApi.mkdir(nested);
      await fsApi.writeFile(join(nested, "x.html"), encodeUtf8("x"));
      expect(new TextDecoder().decode(await readBytesAt(join(nested, "x.html")))).toBe("x");
      expect((await fsApi.lstat(join(nested, "x.html"))).isFile()).toBe(true);
      expect(await fsApi.readdir(nested)).toEqual(["x.html"]);
      await fsApi.rename(join(nested, "x.html"), join(nested, "y.html"));
      expect(await fsApi.readdir(nested)).toEqual(["y.html"]);
      await symlinkAt(join(nested, "y.html"), join(dir, "link.html"));
      expect(await fsApi.realpath(join(dir, "link.html"))).toBe(
        await realDirOf(join(nested, "y.html")),
      );
      await fsApi.unlink(join(nested, "y.html"));
      expect(await codeOfAsync(() => fsApi.unlink(join(nested, "y.html")))).toBe("ENOENT");
      expect(sha1Of(await fsApi.realpath(nested))).toHaveLength(40);
    });
  });

  it("should surface a missing file from readFile", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), "x");
      expect(await codeOfAsync(() => fsApi.readFile(join(dir, "missing.html")))).toBe("ENOENT");
    });
  });
});
