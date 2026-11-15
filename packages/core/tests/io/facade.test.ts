// 这层管：分层门禁的可执行版——门面导出面、纯层不 import io/node:*、只有 node-fs 碰 node:fs。

import { join } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import * as ioFacade from "../../src/io";
import * as pureFacade from "../../src/ops/patchNode";
import * as rootEntry from "../../src/index";

const SRC = join(import.meta.dirname, "..", "..", "src");
const PURE_DIR = join(SRC, "ops", "patchNode");

const walk = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    files.push(...((await stat(path)).isDirectory() ? await walk(path) : [path]));
  }
  return files;
};

const importsIn = async (path: string): Promise<string[]> => {
  const text = await readFile(path, "utf8");
  return [...text.matchAll(/from\s+"([^"]+)"/gu)].flatMap((matched) => matched[1] ?? []);
};

const relevant = (specifier: string): boolean =>
  specifier.startsWith("node:") || /(^|\/)io(\/|$)/u.test(specifier) || specifier === "../io";

describe("门面导出面", () => {
  it("should expose exactly the io orchestrator surface", () => {
    // 同一公开面的第二处拼写在 `packages/core/tests/entry-points.test.ts`（根 barrel 的精确集）：
    // 往 io 门面加导出时两处都要动，否则只有这一半会红。
    expect(Object.keys(ioFacade).sort()).toEqual([
      "isInside",
      "isInsideOrSelf",
      "nodePatchDeps",
      "patchFile",
      "undoPatch",
    ]);
  });

  it("should expose exactly applyPatch and parseFragment from the pure layer", () => {
    expect(Object.keys(pureFacade).sort()).toEqual(["applyPatch", "parseFragment"]);
  });

  it("should re-export the patch surface from the package entry", () => {
    expect(Object.keys(rootEntry)).toEqual(
      expect.arrayContaining([
        "applyPatch",
        "parseFragment",
        "patchFile",
        "undoPatch",
        "nodePatchDeps",
      ]),
    );
  });
});

describe("纯层隔离", () => {
  it("should keep ops/patchNode free of fs and io imports", async () => {
    const files = await walk(PURE_DIR);
    const offenders: string[] = [];
    for (const file of files) {
      for (const specifier of await importsIn(file)) {
        if (relevant(specifier) || specifier.includes("node-fs"))
          offenders.push(`${file}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("should confine node:fs to node-fs.ts", async () => {
    const files = await walk(SRC);
    const offenders: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      if (text.includes('"node:fs') || text.includes("'node:fs")) {
        offenders.push(file.slice(SRC.length + 1));
      }
    }
    // server/ 自己的 fs 访问（daemon.json、fs.watch）是独立层，不转道 io/node-fs。
    expect(offenders).toEqual(["io/node-fs.ts", "server/daemon.ts", "server/watcher.ts"]);
  });
});
