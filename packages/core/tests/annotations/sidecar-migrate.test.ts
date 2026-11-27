// This layer: `migrateMetaAnnotations` — the two-step meta→sidecar move. Invariants under test:
// sidecar copy lands first (a crash in step two loses nothing), meta removal reuses the
// snapshot+atomic+undo pipeline (body bytes untouched, revert restores them exactly), and any
// re-run converges instead of duplicating.

import { chmod, readdir } from "node:fs/promises";
import { join } from "node:path";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { readAnnotations } from "../../src/annotations";
import { serializeSidecarFile, type SidecarAnnotation } from "../../src/annotations/sidecar-model";
import { nodePatchDeps } from "../../src/io/node-fs";
import { annotationFileOf } from "../../src/io/annotation-store";
import { resolveTarget } from "../../src/io/paths";
import { undoPatch } from "../../src/io/undo";
import { listDocAnnotations, migrateMetaAnnotations } from "../../src/ops/sidecar-ops";
import {
  codeOfAsync,
  existsAt,
  fixedClock,
  mkdirAt,
  readBytesAt,
  readTextAt,
  realDirOf,
  sha256Of,
  systemError,
  withWorkspace,
  writeTextAt,
} from "../io/harness";

const FILE = "doc.html";
const AT = Date.now() + 60_000;
const META_MARK = '<script id="hr-meta"';

const depsAt = () => ({ ...nodePatchDeps, ...fixedClock(AT) });

const docWithMeta = (annotations: readonly unknown[]): string =>
  [
    "<!doctype html>",
    '<html><body><article data-hr-id="hr-a"><p data-hr-id="hr-b">正文一</p><p data-hr-id="hr-c">正文二</p></article>',
    `<script id="hr-meta" type="application/json">${JSON.stringify({ version: 1, annotations })}</script>`,
    "</body></html>",
  ].join("\n");

const metaRecord = (id: string, nodeId = "hr-b", note = "meta 批注"): Record<string, unknown> => ({
  id,
  nodeId,
  anchor: { exact: "正文一", prefix: "", suffix: "", start: 0 },
  note,
  status: "pending",
  createdAt: "t0",
});

const sidecarPathAt = async (dir: string, relFile = FILE): Promise<string> => {
  const target = await resolveTarget({ workspace: dir, file: relFile }, nodePatchDeps.fs);
  return annotationFileOf(target);
};

const seed = async (dir: string, html: string): Promise<string> => {
  const path = join(dir, FILE);
  await writeTextAt(path, html);
  return path;
};

const sidecarAnnotations = async (dir: string): Promise<readonly Record<string, unknown>[]> => {
  const path = await sidecarPathAt(dir);
  if (!(await existsAt(path))) return [];
  return (JSON.parse(await readTextAt(path)) as { annotations: Record<string, unknown>[] })
    .annotations;
};

describe("migrateMetaAnnotations · happy path", () => {
  it("should copy meta records into the sidecar and empty hr-meta, body bytes untouched", async () => {
    await withWorkspace(async (dir) => {
      const path = await seed(
        dir,
        docWithMeta([metaRecord("an-aaaa0000"), metaRecord("an-bbbb1111", "hr-c")]),
      );
      const bodyBefore = (await readTextAt(path)).split(META_MARK)[0] ?? "";

      const result = await migrateMetaAnnotations({ workspace: dir, file: FILE }, depsAt());

      expect(result).toMatchObject({ migrated: 2, skipped: 0, changed: true });
      expect(result.historyPath).not.toBeNull();
      const stored = await sidecarAnnotations(dir);
      expect(stored.map((entry) => entry["id"])).toEqual(["an-aaaa0000", "an-bbbb1111"]);
      expect(stored[0]).toMatchObject({ author: "user", replies: [], nodeId: "hr-b" });
      const meta = readAnnotations(await readTextAt(path));
      expect(meta.annotations).toEqual([]);
      // Only the hr-meta payload may differ; every byte before it is identical.
      expect((await readTextAt(path)).split(META_MARK)[0]).toBe(bodyBefore);
    });
  });

  it("should report changed=false when hr-meta has no annotations", async () => {
    await withWorkspace(async (dir) => {
      const path = await seed(dir, docWithMeta([]));
      const before = await readBytesAt(path);

      const result = await migrateMetaAnnotations({ workspace: dir, file: FILE }, depsAt());

      expect(result).toMatchObject({ migrated: 0, skipped: 0, changed: false, historyPath: null });
      expect(sha256Of(await readBytesAt(path))).toBe(sha256Of(before));
      expect(await sidecarAnnotations(dir)).toEqual([]);
    });
  });

  it("should be a no-op on a foreign doc without hr-meta", async () => {
    await withWorkspace(async (dir) => {
      const path = await seed(dir, "<html><body><div><p>foreign</p></div></body></html>");
      const before = await readBytesAt(path);

      const result = await migrateMetaAnnotations({ workspace: dir, file: FILE }, depsAt());

      expect(result.changed).toBe(false);
      expect(sha256Of(await readBytesAt(path))).toBe(sha256Of(before));
    });
  });

  it("should leave an exactly-empty annotations array in hr-meta", async () => {
    await withWorkspace(async (dir) => {
      const path = await seed(dir, docWithMeta([metaRecord("an-aaaa0000")]));

      await migrateMetaAnnotations({ workspace: dir, file: FILE }, depsAt());

      const meta = readAnnotations(await readTextAt(path));
      expect(meta.annotations).toEqual([]);
      expect(meta.diagnostics).toEqual([]);
      expect(await readTextAt(path)).toContain('"annotations":[]');
    });
  });

  it("should carry a corrupt sidecar's diagnostics and preserve its bytes aside", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir, docWithMeta([metaRecord("an-aaaa0000")]));
      const dirPath = join(await realDirOf(dir), ".hreader", "annotations");
      await mkdirAt(dirPath);
      await writeTextAt(await sidecarPathAt(dir), "{ not json");

      const result = await migrateMetaAnnotations({ workspace: dir, file: FILE }, depsAt());

      expect(result).toMatchObject({ migrated: 1, skipped: 0, changed: true });
      expect(result.diagnostics).toContain("侧车批注文件不是合法 JSON 对象，按空批注处理");
      const names = await readdir(dirPath);
      expect(names.some((name) => /\.corrupt-.+\.json$/u.test(name))).toBe(true);
      expect((await sidecarAnnotations(dir)).map((entry) => entry["id"])).toEqual(["an-aaaa0000"]);
    });
  });
});

describe("migrateMetaAnnotations · idempotence and crash recovery", () => {
  it("should skip ids already in the sidecar and complete the meta removal", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir, docWithMeta([metaRecord("an-aaaa0000"), metaRecord("an-bbbb1111")]));
      await mkdirAt(join(await realDirOf(dir), ".hreader", "annotations"));
      await writeTextAt(
        await sidecarPathAt(dir),
        serializeSidecarFile(FILE, [
          {
            id: "an-aaaa0000",
            nodeId: "hr-b",
            anchor: { exact: "正文一", prefix: "", suffix: "", start: 0 },
            note: "已在侧车",
            status: "pending",
            createdAt: "t1",
            author: "user",
            replies: [],
          },
        ]),
      );

      const result = await migrateMetaAnnotations({ workspace: dir, file: FILE }, depsAt());

      expect(result).toMatchObject({ migrated: 1, skipped: 1, changed: true });
      const stored = await sidecarAnnotations(dir);
      expect(stored).toHaveLength(2);
      // The pre-existing sidecar record keeps its own note — meta never overwrites it.
      expect(stored[0]?.["note"]).toBe("已在侧车");
      expect(readAnnotations(await readTextAt(join(dir, FILE))).annotations).toEqual([]);
    });
  });

  it("should converge after a crash between the sidecar write and the meta removal", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir, docWithMeta([metaRecord("an-aaaa0000"), metaRecord("an-bbbb1111")]));
      // The doc write lands on the canonical realpath — the bomb must match that, not the
      // possibly-symlinked /var spelling.
      const fsPath = join(await realDirOf(dir), FILE);
      const before = await readBytesAt(fsPath);
      const original = await readTextAt(fsPath);

      // Crash the atomic document write once: the sidecar write already landed.
      const fs = nodePatchDeps.fs;
      const realWrite = fs.writeFileAtomic.bind(fs);
      let bombed = false;
      const bombedDeps = {
        ...depsAt(),
        fs: {
          ...fs,
          writeFileAtomic: async (path: string, data: Uint8Array) => {
            if (!bombed && path === fsPath) {
              bombed = true;
              throw systemError("EIO");
            }
            await realWrite(path, data);
          },
        },
      };

      const code = await codeOfAsync(() =>
        migrateMetaAnnotations({ workspace: dir, file: FILE }, bombedDeps),
      );

      expect(code).toBe("io_failure");
      // Crash semantics: sidecar copy landed, meta still intact — nothing lost.
      expect((await sidecarAnnotations(dir)).map((entry) => entry["id"]).sort()).toEqual([
        "an-aaaa0000",
        "an-bbbb1111",
      ]);
      expect(await readTextAt(fsPath)).toBe(original);

      const rerun = await migrateMetaAnnotations({ workspace: dir, file: FILE }, depsAt());

      expect(rerun).toMatchObject({ migrated: 0, skipped: 2, changed: true });
      expect((await sidecarAnnotations(dir)).map((entry) => entry["id"]).sort()).toEqual([
        "an-aaaa0000",
        "an-bbbb1111",
      ]);
      expect(readAnnotations(await readTextAt(fsPath)).annotations).toEqual([]);
      expect((await readBytesAt(fsPath)).length).toBeLessThan(before.length);
    });
  });

  it("should leave the sidecar file alone when re-run converged (no copies to write)", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir, docWithMeta([metaRecord("an-aaaa0000")]));
      await migrateMetaAnnotations({ workspace: dir, file: FILE }, depsAt());
      const sidecarBefore = await readBytesAt(await sidecarPathAt(dir));

      const second = await migrateMetaAnnotations({ workspace: dir, file: FILE }, depsAt());

      // Meta is already empty: the op short-circuits before touching anything.
      expect(second).toMatchObject({ migrated: 0, skipped: 0, changed: false });
      expect(sha256Of(await readBytesAt(await sidecarPathAt(dir)))).toBe(sha256Of(sidecarBefore));
    });
  });

  it("should skip the sidecar write entirely when every meta id already exists", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir, docWithMeta([metaRecord("an-aaaa0000"), metaRecord("an-bbbb1111")]));
      await mkdirAt(join(await realDirOf(dir), ".hreader", "annotations"));
      const sidecarPath = await sidecarPathAt(dir);
      const present = (id: string): SidecarAnnotation => ({
        id,
        nodeId: "hr-b",
        anchor: { exact: "正文一", prefix: "", suffix: "", start: 0 },
        note: "已在侧车",
        status: "pending",
        createdAt: "t1",
        author: "user",
        replies: [],
      });
      await writeTextAt(
        sidecarPath,
        serializeSidecarFile(FILE, [present("an-aaaa0000"), present("an-bbbb1111")]),
      );
      // A read-only sidecar proves the write is never attempted: an attempted write would
      // surface io_failure instead of converging.
      await chmod(sidecarPath, 0o444);

      const result = await migrateMetaAnnotations({ workspace: dir, file: FILE }, depsAt());

      expect(result).toMatchObject({ migrated: 0, skipped: 2, changed: true });
      expect(readAnnotations(await readTextAt(join(dir, FILE))).annotations).toEqual([]);
      expect((await sidecarAnnotations(dir)).map((entry) => entry["id"]).sort()).toEqual([
        "an-aaaa0000",
        "an-bbbb1111",
      ]);
    });
  });

  it("should migrate a random annotation set exactly once under repeat runs", async () => {
    const ids = fc.uniqueArray(fc.string({ minLength: 1, maxLength: 10 }), {
      selector: (id) => id,
      minLength: 0,
      maxLength: 12,
    });
    await fc.assert(
      fc.asyncProperty(ids, async (generated) => {
        await withWorkspace(async (dir) => {
          const records = generated.map((id) => metaRecord(`an-${id}`));
          await seed(dir, docWithMeta(records));

          const first = await migrateMetaAnnotations({ workspace: dir, file: FILE }, depsAt());
          const second = await migrateMetaAnnotations({ workspace: dir, file: FILE }, depsAt());

          const stored = await sidecarAnnotations(dir);
          expect(new Set(stored.map((entry) => entry["id"]))).toEqual(
            new Set(records.map((entry) => entry["id"])),
          );
          expect(stored).toHaveLength(records.length);
          expect(first.migrated).toBe(records.length);
          expect(second).toMatchObject({ migrated: 0, skipped: 0, changed: false });
          expect(readAnnotations(await readTextAt(join(dir, FILE))).annotations).toEqual([]);
        });
      }),
      { numRuns: 15 },
    );
  });
});

describe("migrateMetaAnnotations · undo and listing", () => {
  it("should restore the original bytes exactly on undo", async () => {
    await withWorkspace(async (dir) => {
      const path = await seed(
        dir,
        docWithMeta([metaRecord("an-aaaa0000"), metaRecord("an-bbbb1111")]),
      );
      const original = await readBytesAt(path);

      await migrateMetaAnnotations({ workspace: dir, file: FILE }, depsAt());
      const undone = await undoPatch({ workspace: dir, file: FILE }, depsAt());

      expect(undone.bytes).toBe(original.length);
      expect(sha256Of(await readBytesAt(path))).toBe(sha256Of(original));
      // The sidecar copy stays: undo reverts the document, not the store — a following
      // migrate run sees the ids as already-present and skips them.
      expect(await sidecarAnnotations(dir)).toHaveLength(2);
    });
  });

  it("should expose migrated records through the merged read with source=sidecar", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir, docWithMeta([metaRecord("an-aaaa0000")]));
      await migrateMetaAnnotations({ workspace: dir, file: FILE }, depsAt());

      const listed = await listDocAnnotations({ workspace: dir, file: FILE }, depsAt());

      expect(listed.annotations).toHaveLength(1);
      expect(listed.annotations[0]).toMatchObject({
        source: "sidecar",
        annotation: { id: "an-aaaa0000", nodeId: "hr-b", createdAt: "t0" },
      });
      expect(listed.annotations[0]?.anchor).toMatchObject({ ok: true, via: "node" });
    });
  });

  it("should keep meta diagnostics when hr-meta is dirty but has no usable records", async () => {
    await withWorkspace(async (dir) => {
      await seed(dir, docWithMeta([{ nodeId: "hr-b" }]));

      const result = await migrateMetaAnnotations({ workspace: dir, file: FILE }, depsAt());

      // The dirty record reads as skipped dirt: nothing to migrate.
      expect(result.migrated).toBe(0);
      expect(result.changed).toBe(false);
      expect(result.diagnostics.length).toBeGreaterThan(0);
    });
  });
});
