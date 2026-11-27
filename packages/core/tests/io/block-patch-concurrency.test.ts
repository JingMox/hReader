// This layer: two real subprocesses patchBlock the same file at once — with a real lock
// timeout both serialize, no write is lost and no `data-hr-id` leaks into foreign bytes.

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { nodePatchDeps, undoPatch } from "../../src/io";
import { listBlocks } from "../../src/ops/block-address";
import { patchBlock } from "../../src/ops/patch-block";
import { fieldOf, spawnFixture } from "./spawn";
import {
  codeOfAsync,
  historyNamesOf,
  lockPathAt,
  mkdirAt,
  readTextAt,
  withWorkspace,
  writeTextAt,
} from "./harness";

const FILE = "post.html";
const DOC = "<article><p>one</p><p>two</p><p>three</p></article>";

const raceOf = async (dir: string, timeoutMs: string) => {
  const one = spawnFixture("block-patch-worker.mjs", [dir, FILE, "甲", timeoutMs]);
  const two = spawnFixture("block-patch-worker.mjs", [dir, FILE, "乙", timeoutMs]);
  await one.next();
  await two.next();
  one.go();
  two.go();
  const first = await one.next();
  const second = await two.next();
  const codes = [(await one.exit).code, (await two.exit).code];
  return { first, second, codes };
};

describe("concurrency · two subprocesses patchBlock one file", () => {
  it("should serialize both writes with no lost update", { timeout: 30_000 }, async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, FILE), DOC);
      const { first, second, codes } = await raceOf(dir, "15000");

      expect(codes).toEqual([0, 0]);
      expect(fieldOf(first, "ok")).toBe(true);
      expect(fieldOf(second, "ok")).toBe(true);

      // Both inserts landed: the file holds both markers, each exactly once, and
      // every listed block still round-trips on the final bytes.
      const html = await readTextAt(join(dir, FILE));
      expect(html).toContain("<p>甲</p>");
      expect(html).toContain("<p>乙</p>");
      expect(html.match(/<p>甲<\/p>/gu)).toHaveLength(1);
      expect(html.match(/<p>乙<\/p>/gu)).toHaveLength(1);
      expect(html).not.toContain("data-hr-id");
      for (const block of listBlocks(html)) {
        expect(html.slice(block.start, block.end)).toContain(`<${block.tag}`);
      }
      // Two serialized writes → two snapshots → two undo steps available.
      expect(await historyNamesOf(dir, FILE)).toHaveLength(2);
    });
  });

  it("should report locked to a worker holding timeout 0 and leave bytes alone", async () => {
    await withWorkspace(async (dir) => {
      const file = join(dir, FILE);
      await writeTextAt(file, DOC);
      // Hold the lock ourselves: a timeout-0 worker must refuse without writing.
      await mkdirAt(join(dir, ".hreader", "locks"));
      const lock = await lockPathAt(dir, FILE);
      await writeTextAt(lock, JSON.stringify({ pid: process.pid, nonce: "held", at: Date.now() }));
      const worker = spawnFixture("block-patch-worker.mjs", [dir, FILE, "甲", "0"]);
      await worker.next();
      worker.go();
      const result = await worker.next();
      expect(fieldOf(result, "ok")).toBe(false);
      expect(fieldOf(result, "code")).toBe("locked");
      expect(await worker.exit).toEqual({ code: 0, signal: null });
      expect(await readTextAt(file)).toBe(DOC);
    });
  });

  it("should undo a concurrent pair of writes in reverse order", async () => {
    await withWorkspace(async (dir) => {
      const file = join(dir, FILE);
      await writeTextAt(file, DOC);
      const address = listBlocks(DOC)[0]?.address ?? "";
      await patchBlock(
        { workspace: dir, file: FILE, address, action: "insertAfter", html: "<p>x</p>" },
        nodePatchDeps,
      );
      const mid = await readTextAt(file);
      await patchBlock(
        {
          workspace: dir,
          file: FILE,
          address: listBlocks(mid)[0]?.address ?? "",
          action: "insertAfter",
          html: "<p>y</p>",
        },
        nodePatchDeps,
      );
      await undoPatch({ workspace: dir, file: FILE }, nodePatchDeps);
      expect(await readTextAt(file)).toBe(mid);
      await undoPatch({ workspace: dir, file: FILE }, nodePatchDeps);
      expect(await readTextAt(file)).toBe(DOC);
      expect(
        await codeOfAsync(() => undoPatch({ workspace: dir, file: FILE }, nodePatchDeps)),
      ).toBe("undo_unavailable");
    });
  });
});
