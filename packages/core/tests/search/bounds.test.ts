// Bounds: the 5000-doc cap yields `truncated` + a diagnostic; a 1 MB body is capped at the
// 200 KB contract; the 200-code-point query bound and the 1..100 limit bound are enforced.

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { nodePatchDeps } from "../../src/io/node-fs";
import { searchLibrary, SEARCH_LIMITS } from "../../src/search";
import { BODY_TEXT_CAP } from "../../src/search/extract";
import { codeOfAsync, writeTextAt, withWorkspace } from "../io/harness";

const DOC = (title: string, body: string): string =>
  `<!doctype html><html><head><title>${title}</title></head><body><p>${body}</p></body></html>`;

describe("search bounds", () => {
  it(`caps the library at ${String(SEARCH_LIMITS.docs)} docs with truncated + a diagnostic`, async () => {
    await withWorkspace(async (dir) => {
      // Chunked fan-out: one await per batch keeps the loop serial enough for the fs but
      // never builds a 5000-deep pending-write storm.
      const BATCH = 250;
      for (let batch = 0; batch < SEARCH_LIMITS.docs + 1; batch += BATCH) {
        const writes: Promise<void>[] = [];
        for (
          let index = batch;
          index < Math.min(batch + BATCH, SEARCH_LIMITS.docs + 1);
          index += 1
        ) {
          writes.push(
            writeTextAt(
              join(dir, `d${String(index).padStart(5, "0")}.html`),
              DOC("t", `marker-${String(index)}`),
            ),
          );
        }
        await Promise.all(writes);
      }
      const result = await searchLibrary({ workspace: dir, query: "marker" }, nodePatchDeps);
      expect(result.truncated).toBe(true);
      expect(result.diagnostics.some((line) => line.includes("5000"))).toBe(true);
      expect(result.results.length).toBeGreaterThan(0);
    });
  }, 60_000);

  it("caps a 1 MB body at the 200 KB contract", async () => {
    await withWorkspace(async (dir) => {
      const early = "葡萄栽培要点 ";
      const filler = "水分".repeat(BODY_TEXT_CAP);
      const late = "稀缺词条松露鹅肝";
      await writeTextAt(join(dir, "big.html"), DOC("大文档", early + filler + late));
      const found = await searchLibrary({ workspace: dir, query: "葡萄栽培" }, nodePatchDeps);
      expect(found.results[0]?.path).toBe("big.html");
      // The tail term sits past the cap: it was never indexed.
      const missed = await searchLibrary({ workspace: dir, query: "松露鹅肝" }, nodePatchDeps);
      expect(missed.results).toEqual([]);
    });
  });

  it("accepts a 200-code-point query and refuses 201", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "填充"));
      const at = "检索".repeat(100);
      expect(Array.from(at)).toHaveLength(200);
      const ok = await searchLibrary({ workspace: dir, query: at }, nodePatchDeps);
      expect(ok.results).toEqual([]);
      const over = `${at}词`;
      expect(
        await codeOfAsync(() => searchLibrary({ workspace: dir, query: over }, nodePatchDeps)),
      ).toBe("invalid_request");
      // Code points are the unit, not UTF-16 units: 200 emoji (400 units) is legal.
      const emoji = "🔍".repeat(200);
      const emojiResult = await searchLibrary({ workspace: dir, query: emoji }, nodePatchDeps);
      expect(emojiResult.results).toEqual([]);
    });
  });

  it("refuses an empty query", async () => {
    await withWorkspace(async (dir) => {
      expect(
        await codeOfAsync(() => searchLibrary({ workspace: dir, query: "" }, nodePatchDeps)),
      ).toBe("invalid_request");
    });
  });

  it("refuses limit values outside 1..100 or non-integers", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "葡萄"));
      for (const limit of [0, 101, -3, Number.NaN, 1.5]) {
        expect(
          await codeOfAsync(() =>
            searchLibrary({ workspace: dir, query: "葡萄", limit }, nodePatchDeps),
          ),
        ).toBe("invalid_request");
      }
      const one = await searchLibrary({ workspace: dir, query: "葡萄", limit: 1 }, nodePatchDeps);
      expect(one.results).toHaveLength(1);
    });
  });
});
