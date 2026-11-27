// 这层管：node-fs 端口的真实行为（wx 独占、sync、关闭幂等、writeFileAtomic 落盘）与默认 deps 的形状；不测业务编排。

import { chmodSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { encodeUtf8 } from "../../src/io/bytes";
import { nodePatchDeps } from "../../src/io/node-fs";
import type { OpenFile } from "../../src/io/ports";
import {
  codeOfAsync,
  existsAt,
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
      "close",
      "link",
      "lstat",
      "mkdir",
      "open",
      "readFile",
      "readdir",
      "realpath",
      "rename",
      "rmdir",
      "unlink",
      "writeFile",
      "writeFileAtomic",
    ]);
    // Real clock proven by bracketing: the sampled time must lie inside
    // [before, after] — a frozen or stubbed clock falls outside it. No
    // elapsed-time budget involved, so scheduling stalls can't flake it.
    const before = Date.now();
    const now = nodePatchDeps.clock.now();
    const after = Date.now();
    expect(now instanceof Date).toBe(true);
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
    expect(now.getTime()).toBeLessThanOrEqual(after);
    await expect(nodePatchDeps.sleep(1)).resolves.toBeUndefined();
  });
});

describe("node-fs · 独占打开", () => {
  it("should create, fsync and close a file exactly once", async () => {
    await withWorkspace(async (dir) => {
      const file = join(dir, "a.html");
      const handle = await fsApi.open(file);
      await handle.write(encodeUtf8("正文"));
      await handle.sync();
      await fsApi.close(handle);

      expect(await readTextAt(file)).toBe("正文");
      expect(await codeOfAsync(() => fsApi.open(file))).toBe("EEXIST");
    });
  });

  it("should make close idempotent and ignore foreign handles", async () => {
    await withWorkspace(async (dir) => {
      const handle = await fsApi.open(join(dir, "a.html"));
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

describe("node-fs · writeFileAtomic", () => {
  it("should write a new file and leave no tmp residue beside it", async () => {
    await withWorkspace(async (dir) => {
      const file = join(dir, "a.html");
      await fsApi.writeFileAtomic(file, encodeUtf8("落盘"));

      expect(await readTextAt(file)).toBe("落盘");
      // write-file-atomic 的 tmp 是 `a.html.<数字>`：落盘成功后必须清干净。
      expect(readdirSync(dir)).toEqual(["a.html"]);
    });
  });

  it("should replace an existing file and keep its permission bits", async () => {
    await withWorkspace(async (dir) => {
      const file = join(dir, "a.html");
      await writeTextAt(file, "old");
      chmodSync(file, 0o640);
      await fsApi.writeFileAtomic(file, encodeUtf8("new"));

      expect(await readTextAt(file)).toBe("new");
      expect(statSync(file).mode & 0o777).toBe(0o640);
      expect(readdirSync(dir)).toEqual(["a.html"]);
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
      // rmdir only takes empty dirs: a populated one is ENOTEMPTY until it is emptied.
      await fsApi.mkdir(join(dir, "hold"));
      await writeTextAt(join(dir, "hold", "z.html"), "z");
      expect(await codeOfAsync(() => fsApi.rmdir(join(dir, "hold")))).toBe("ENOTEMPTY");
      await fsApi.unlink(join(dir, "hold", "z.html"));
      await fsApi.rmdir(join(dir, "hold"));
      expect(await existsAt(join(dir, "hold"))).toBe(false);
    });
  });

  it("should surface a missing file from readFile", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), "x");
      expect(await codeOfAsync(() => fsApi.readFile(join(dir, "missing.html")))).toBe("ENOENT");
    });
  });
});

describe("node-fs · link", () => {
  it("should hard-link and refuse to overwrite an existing target", async () => {
    const link = fsApi.link;
    if (link === undefined) throw new Error("node fs must provide link");
    await withWorkspace(async (dir) => {
      const from = join(dir, "a.html");
      const to = join(dir, "b.html");
      await writeTextAt(from, "shared");

      await link(from, to);
      expect(await readTextAt(to)).toBe("shared");
      expect(statSync(from).ino).toBe(statSync(to).ino);
      expect(await codeOfAsync(() => link(from, to))).toBe("EEXIST");
    });
  });
});
