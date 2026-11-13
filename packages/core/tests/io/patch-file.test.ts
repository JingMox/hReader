// 这层管：`patchFile` 的落盘编排（真实 fs）——写盘、history 快照、幂等不写盘、undo 还原、目标拒绝。

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { nodePatchDeps, patchFile } from "../../src/io";
import type { PatchRequest } from "../../src/ops/patchNode";
import { ARTICLE_DOC, DOC_FILE } from "./fixtures";
import {
  historyDirAt,
  historyNamesOf,
  readBytesAt,
  readTextAt,
  realDirOf,
  sha256Of,
  withWorkspace,
  writeTextAt,
} from "./harness";
import { childIds, elementById, textIn } from "./tree-probe";

const deps = nodePatchDeps;

const fileAt = (dir: string): string => join(dir, DOC_FILE);

const seed = async (dir: string): Promise<string> => {
  await writeTextAt(fileAt(dir), ARTICLE_DOC);
  return sha256Of(await readBytesAt(fileAt(dir)));
};

const historyOf = (dir: string): Promise<string[]> => historyNamesOf(dir, DOC_FILE);

const expectSnapshot = async (
  dir: string,
  historyPath: string | null,
  before: string,
): Promise<void> => {
  const names = await historyOf(dir);
  expect(names).toHaveLength(1);
  expect(historyPath).toBe(join(await historyDirAt(dir, DOC_FILE), names[0] ?? "<missing>"));
  expect(sha256Of(await readBytesAt(String(historyPath)))).toBe(before);
};

const patchOf = (dir: string, request: PatchRequest): ReturnType<typeof patchFile> =>
  patchFile({ workspace: dir, file: DOC_FILE, request }, deps);

describe("patchFile · 写盘与快照", () => {
  it("should rewrite the file and snapshot the original bytes", async () => {
    await withWorkspace(async (dir) => {
      const before = await seed(dir);
      const result = await patchOf(dir, { targetId: "p1", action: "replace", html: "<p>换</p>" });
      const after = await readBytesAt(fileAt(dir));
      const realDir = await realDirOf(dir);

      expect(result.changed).toBe(true);
      expect(result.undoable).toBe(true);
      expect(result.newIds).toHaveLength(1);
      expect(result.bytes).toBe(after.length);
      expect(result.path).toBe(join(realDir, DOC_FILE));
      expect(sha256Of(after)).not.toBe(before);
      expect(textIn(after.toString("utf8"), String(result.newIds[0]))).toBe("换");
      await expectSnapshot(dir, result.historyPath, before);
    });
  });

  it("should append inside the target and keep the untouched subtree", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      const result = await patchOf(dir, { targetId: "box", action: "append", html: "<p>加</p>" });
      const html = await readTextAt(fileAt(dir));

      expect(childIds(html, "box")).toEqual(["p0", String(result.newIds[0])]);
      expect(textIn(html, "box")).toBe("零加");
    });
  });
});

describe("patchFile · 写盘与快照（续）", () => {
  it("should delete the target and allocate no id", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir);
      const result = await patchOf(dir, { targetId: "p2", action: "delete" });
      const html = await readTextAt(fileAt(dir));

      expect(result.newIds).toEqual([]);
      expect(childIds(html, "root")).toEqual(["h1", "box", "p1"]);
      expect(elementById(html, "p2")).toBeUndefined();
    });
  });
});

describe("patchFile · changed:false 不写盘", () => {
  it("should leave bytes and history untouched for identical content", async () => {
    await withWorkspace(async (dir) => {
      const before = await seed(dir);
      const original = await readBytesAt(fileAt(dir));
      const result = await patchOf(dir, {
        targetId: "p1",
        action: "replace",
        html: '<p data-hr-id="p1" class="lead">第一段</p>',
      });

      expect(result.changed).toBe(false);
      expect(result.historyPath).toBeNull();
      expect(result.newIds).toEqual([]);
      expect(result.undoable).toBe(false);
      expect(result.bytes).toBe(original.length);
      expect(sha256Of(await readBytesAt(fileAt(dir)))).toBe(before);
      expect(await historyOf(dir)).toEqual([]);
    });
  });
});
