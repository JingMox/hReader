// This layer: N real child processes racing createFromTemplate on the same target — exactly one
// winner per round, every loser gets file_exists, the tree is byte-complete and no tmp survives.
// Determinism: no sleeps; every worker is held on the IPC barrier until all N are ready.

import { stat } from "node:fs/promises";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { nodePatchDeps } from "../../src/io";
import { createFromTemplate } from "../../src/templates";
import {
  mkdirAt,
  mkdtempAt,
  namesInOrEmpty,
  readBytesAt,
  rmAt,
  withWorkspace,
  writeTextAt,
} from "../io/harness";
import { fieldOf, spawnFixture, type FixtureWorker } from "../io/spawn";

const WORKERS = 8;
const FLAT_ROUNDS = 20;
const NESTED_ROUNDS = 6;

const ASSETS: Record<string, string> = {
  "a/b/c.png": "PNG-BYTES",
  "d/e.bin": "BIN-BYTES",
};

const ENTRY =
  '<html><head><title>R</title></head><body><img src="assets/a/b/c.png"><p>x</p></body></html>';

const seedTemplate = async (home: string): Promise<void> => {
  const tpl = join(home, ".hreader", "templates", "race-tpl");
  await mkdirAt(join(tpl, "assets", "a", "b"));
  await mkdirAt(join(tpl, "assets", "d"));
  await writeTextAt(
    join(tpl, "template.json"),
    JSON.stringify({
      id: "race-tpl",
      name: "Race",
      description: "fixture",
      version: 1,
      format: "html",
      tags: [],
    }),
  );
  await writeTextAt(join(tpl, "index.html"), ENTRY);
  for (const [rel, text] of Object.entries(ASSETS)) {
    await writeTextAt(join(tpl, "assets", rel), text);
  }
};

/** Recursive file listing under `dir`, minus the `.hreader` store (lock infra, not payload). */
const payloadFiles = async (dir: string): Promise<readonly string[]> => {
  const out: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const name of await namesInOrEmpty(current)) {
      const path = join(current, name);
      const rel = relative(dir, path);
      if (rel === ".hreader" || rel.startsWith(`.hreader/`)) continue;
      if ((await stat(path)).isDirectory()) await walk(path);
      else out.push(rel);
    }
  };
  await walk(dir);
  return [...out].sort();
};

const round = async (ws: string, home: string, target: string): Promise<readonly unknown[]> => {
  const workers: FixtureWorker[] = Array.from({ length: WORKERS }, () =>
    spawnFixture("create-worker.mjs", [ws, home, "race-tpl", target]),
  );
  // Barrier: every worker reports ready, then all are released at once.
  await Promise.all(workers.map((worker) => worker.next()));
  for (const worker of workers) worker.go();
  const results = await Promise.all(workers.map((worker) => worker.next()));
  const exits = await Promise.all(workers.map((worker) => worker.exit));
  expect(exits.map((exit) => exit.code)).toEqual(Array.from({ length: WORKERS }, () => 0));
  return results;
};

const expectOneWinner = (results: readonly unknown[]): void => {
  const winners = results.filter((result) => fieldOf(result, "ok") === true);
  expect(winners).toHaveLength(1);
  for (const result of results) {
    if (fieldOf(result, "ok") !== true) expect(fieldOf(result, "code")).toBe("file_exists");
  }
};

/** The bytes a lone create produced in-process — the oracle every raced winner must match exactly. */
interface Reference {
  readonly page: Buffer;
  readonly assets: ReadonlyMap<string, Buffer>;
}

/** Remove everything a create at `target` produced: nested targets go via their top dir; flat ones take the page plus `<stem>_files`. */
const cleanupTarget = async (ws: string, target: string): Promise<void> => {
  if (target.includes("/")) {
    await rmAt(join(ws, target.slice(0, target.indexOf("/"))));
    return;
  }
  await rmAt(join(ws, target));
  await rmAt(join(ws, `${target.replace(/\.html$/u, "")}_files`));
};

const referenceOf = async (ws: string, home: string, target: string): Promise<Reference> => {
  await createFromTemplate(
    { id: "race-tpl", target },
    { workspace: ws },
    { ...nodePatchDeps, home },
  );
  const stem = target.replace(/\.html$/u, "");
  const assets = new Map<string, Buffer>();
  for (const rel of Object.keys(ASSETS)) {
    assets.set(rel, await readBytesAt(join(ws, `${stem}_files`, rel)));
  }
  const page = await readBytesAt(join(ws, target));
  await cleanupTarget(ws, target);
  return { page, assets };
};

const expectTree = async (ws: string, target: string, ref: Reference): Promise<void> => {
  const stem = target.replace(/\.html$/u, "");
  const assetsRel = `${stem}_files`;
  const expected = [target, ...Object.keys(ASSETS).map((rel) => `${assetsRel}/${rel}`)].sort();
  const listing = await payloadFiles(ws);
  expect(listing).toEqual(expected);
  expect(await readBytesAt(join(ws, target))).toEqual(ref.page);
  for (const [rel, bytes] of ref.assets) {
    expect(await readBytesAt(join(ws, assetsRel, rel))).toEqual(bytes);
  }
  // No tmp staging leftovers anywhere in the workspace payload tree.
  expect(listing.filter((rel) => /\.\d{3,}$/u.test(rel))).toEqual([]);
};

describe("concurrency · N child processes createFromTemplate on the same target", () => {
  it(
    "should produce exactly one winner with a complete tree across flat-target rounds",
    { timeout: 300_000 },
    async () => {
      await withWorkspace(async (ws) => {
        const home = await mkdtempAt("hreader-race-home-");
        await seedTemplate(home);
        const ref = await referenceOf(ws, home, "doc.html");
        for (let index = 0; index < FLAT_ROUNDS; index += 1) {
          expectOneWinner(await round(ws, home, "doc.html"));
          await expectTree(ws, "doc.html", ref);
          await cleanupTarget(ws, "doc.html");
        }
      });
    },
  );

  it(
    "should produce exactly one winner when the whole parent chain is missing",
    { timeout: 300_000 },
    async () => {
      await withWorkspace(async (ws) => {
        const home = await mkdtempAt("hreader-race-home-");
        await seedTemplate(home);
        const ref = await referenceOf(ws, home, "nest/deep/doc.html");
        for (let index = 0; index < NESTED_ROUNDS; index += 1) {
          expectOneWinner(await round(ws, home, "nest/deep/doc.html"));
          await expectTree(ws, "nest/deep/doc.html", ref);
          await cleanupTarget(ws, "nest/deep/doc.html");
        }
      });
    },
  );
});
