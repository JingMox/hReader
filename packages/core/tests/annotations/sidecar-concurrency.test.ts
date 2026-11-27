// This layer: sidecar ops under real cross-process contention — two OS processes race the same
// document's sidecar file. The per-file lock must serialize them: every add lands exactly once,
// and a concurrent migrate+add ends with the union and an empty hr-meta.

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readAnnotations } from "../../src/annotations";
import { nodePatchDeps } from "../../src/io/node-fs";
import { annotationFileOf } from "../../src/io/annotation-store";
import { resolveTarget } from "../../src/io/paths";
import { listDocAnnotations } from "../../src/ops/sidecar-ops";
import { readTextAt, withWorkspace, writeTextAt } from "../io/harness";
import { fieldOf, spawnFixture, type FixtureWorker } from "../io/spawn";

const FILE = "doc.html";
const MANAGED = [
  "<!doctype html>",
  '<html><body><article data-hr-id="hr-a"><p data-hr-id="hr-b">正文一</p><p data-hr-id="hr-c">正文二</p></article>',
  '<script id="hr-meta" type="application/json">{"version":1,"annotations":[{"id":"an-meta0001","nodeId":"hr-b","anchor":{"exact":"正文一","prefix":"","suffix":"","start":0},"note":"meta 一","status":"pending","createdAt":"t0"},{"id":"an-meta0002","nodeId":"hr-c","anchor":{"exact":"正文二","prefix":"","suffix":"","start":0},"note":"meta 二","status":"pending","createdAt":"t0"}]}</script>',
  "</body></html>",
].join("\n");

const LOCK_WAIT = "20000";

const spawnAdder = (dir: string, prefix: string, count: number): FixtureWorker =>
  spawnFixture("annotate-worker.mjs", [dir, FILE, "add", prefix, String(count), LOCK_WAIT]);

const spawnMigrator = (dir: string): FixtureWorker =>
  spawnFixture("annotate-worker.mjs", [dir, FILE, "migrate", "", "1", LOCK_WAIT]);

const sidecarFileAt = async (dir: string): Promise<string> =>
  annotationFileOf(await resolveTarget({ workspace: dir, file: FILE }, nodePatchDeps.fs));

const sidecarIds = async (dir: string): Promise<readonly string[]> => {
  const text = await readTextAt(await sidecarFileAt(dir));
  return (JSON.parse(text) as { annotations: { id: string }[] }).annotations.map(
    (entry) => entry.id,
  );
};

describe("并发 · 两个子进程同时 add 同一文档的侧车", () => {
  it("should land every annotation exactly once with zero lost", { timeout: 60_000 }, async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, FILE), MANAGED);
      const one = spawnAdder(dir, "甲", 8);
      const two = spawnAdder(dir, "乙", 8);
      await one.next();
      await two.next();
      one.go();
      two.go();
      const first = await one.next();
      const second = await two.next();
      const codes = [(await one.exit).code, (await two.exit).code];

      expect(codes).toEqual([0, 0]);
      expect(fieldOf(first, "ok")).toBe(true);
      expect(fieldOf(second, "ok")).toBe(true);
      const ids = await sidecarIds(dir);
      expect(ids).toHaveLength(16);
      expect(new Set(ids).size).toBe(16);
      const stored = await readTextAt(await sidecarFileAt(dir));
      for (const note of ["甲-0", "甲-7", "乙-0", "乙-7"]) {
        expect(stored).toContain(`"note":"${note}"`);
      }
      // The document itself is never touched by sidecar adds.
      expect(await readTextAt(join(dir, FILE))).toBe(MANAGED);
    });
  });
});

describe("并发 · migrate 与 add 同时跑", () => {
  it(
    "should end with the union of meta and added annotations and an empty hr-meta",
    { timeout: 60_000 },
    async () => {
      await withWorkspace(async (dir) => {
        await writeTextAt(join(dir, FILE), MANAGED);
        const migrator = spawnMigrator(dir);
        const adder = spawnAdder(dir, "add", 4);
        await migrator.next();
        await adder.next();
        migrator.go();
        adder.go();
        const migrated = await migrator.next();
        const added = await adder.next();
        const codes = [(await migrator.exit).code, (await adder.exit).code];

        expect(codes).toEqual([0, 0]);
        expect(fieldOf(migrated, "ok")).toBe(true);
        expect(fieldOf(added, "ok")).toBe(true);
        const ids = new Set(await sidecarIds(dir));
        const addedIds = fieldOf(added, "ids");
        expect(addedIds).toBeInstanceOf(Array);
        for (const id of addedIds as string[]) expect(ids.has(id)).toBe(true);
        expect(ids.has("an-meta0001")).toBe(true);
        expect(ids.has("an-meta0002")).toBe(true);
        expect(ids.size).toBe(6);
        expect(readAnnotations(await readTextAt(join(dir, FILE))).annotations).toEqual([]);
        const listed = await listDocAnnotations({ workspace: dir, file: FILE }, nodePatchDeps);
        expect(listed.annotations).toHaveLength(6);
      });
    },
  );
});
