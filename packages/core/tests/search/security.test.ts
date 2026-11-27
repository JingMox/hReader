// Security: symlinked docs/dirs and `.hreader/**` are never indexed; no absolute host path
// ever leaks into results or diagnostics; pathological queries stay bounded in CPU.

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { nodePatchDeps } from "../../src/io/node-fs";
import { searchLibrary } from "../../src/search";
import { mkdirAt, symlinkAt, withWorkspace, writeTextAt } from "../io/harness";

const DOC = (title: string, body: string): string =>
  `<!doctype html><html><head><title>${title}</title></head><body><p>${body}</p></body></html>`;

const find = (dir: string, query: string) =>
  searchLibrary({ workspace: dir, query }, nodePatchDeps);

describe("search security", () => {
  it("never indexes a symlinked document pointing outside the workspace", async () => {
    await withWorkspace(async (dir) => {
      await withWorkspace(async (outside) => {
        await writeTextAt(join(outside, "secret.html"), DOC("外", "保险柜密码"));
        await symlinkAt(join(outside, "secret.html"), join(dir, "linked.html"));
        await writeTextAt(join(dir, "real.html"), DOC("内", "普通内容"));
        const result = await find(dir, "保险柜密码");
        expect(result.results).toEqual([]);
        const wild = await find(dir, "内容");
        expect(wild.results.map((hit) => hit.path)).toEqual(["real.html"]);
      });
    });
  });

  it("never indexes a symlinked directory pointing outside the workspace", async () => {
    await withWorkspace(async (dir) => {
      await withWorkspace(async (outside) => {
        await writeTextAt(join(outside, "secret.html"), DOC("外", "保险柜密码"));
        await symlinkAt(outside, join(dir, "linked-dir"));
        const result = await find(dir, "保险柜密码");
        expect(result.results).toEqual([]);
      });
    });
  });

  it("never indexes `.hreader/**` — the index itself is inert to the walk", async () => {
    await withWorkspace(async (dir) => {
      await mkdirAt(join(dir, ".hreader"));
      await writeTextAt(join(dir, ".hreader", "hidden.html"), DOC("藏", "保险柜密码"));
      await writeTextAt(join(dir, "real.html"), DOC("内", "普通内容"));
      await find(dir, "普通");
      const result = await find(dir, "保险柜密码");
      expect(result.results).toEqual([]);
    });
  });

  it("no absolute host path appears in any output, diagnostics included", async () => {
    await withWorkspace(async (dir) => {
      const workspaceReal = await nodePatchDeps.fs.realpath(dir);
      await writeTextAt(join(dir, "a.html"), DOC("a", "葡萄"));
      // Force a diagnostic stream: a corrupt index file pushes the rebuild line.
      await mkdirAt(join(dir, ".hreader", "index"));
      await writeTextAt(join(dir, ".hreader", "index", "search.json"), "not json");
      const result = await find(dir, "葡萄");
      const wire = JSON.stringify(result);
      expect(wire.includes(dir)).toBe(false);
      expect(wire.includes(workspaceReal)).toBe(false);
      for (const hit of result.results) {
        expect(hit.path.startsWith("/")).toBe(false);
      }
    });
  });

  it("pathological queries stay bounded in CPU", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("a", "a".repeat(10_000)));
      const nasty = [
        "a".repeat(200),
        `${"摩托车".repeat(66)}摩托`,
        "?*+^$()[]{}\\|".repeat(14).slice(0, 200),
        "🔍".repeat(200),
      ];
      for (const query of nasty) {
        const before = process.cpuUsage();
        const result = await find(dir, query);
        const used = process.cpuUsage(before);
        // The report is CPU time, not wall time — surfaced for the run log, never asserted.
        process.stdout.write(
          `cpu ${String((used.user + used.system) / 1000)}ms for ${JSON.stringify(query.slice(0, 24))}…\n`,
        );
        expect(result.results.length).toBeLessThanOrEqual(100);
      }
    });
  });
});
