// This layer covers `hr meta <file>` end to end — read mode (no mutation flags), the
// tag/URL merge flags in human and --json modes, usage exit codes, and path spellings.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { fieldOf, parseJsonLine, withTempDir } from "./harness";
import { runIn } from "./support/capture";

const DOC = (title: string, body: string): string =>
  `<!doctype html><html><head><title>${title}</title></head><body><p>${body}</p></body></html>`;

const seed = (dir: string, file = "a.html"): void => {
  writeFileSync(join(dir, file), DOC("维修", "摩托车 发动机"), "utf8");
};

const data = (result: { stdout: string }): Record<string, unknown> =>
  fieldOf(parseJsonLine(result.stdout), "data") as Record<string, unknown>;

describe("hr meta · read", () => {
  it("prints an empty metadata view in human mode", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const result = await runIn(dir, ["meta", "a.html"]);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("meta a.html（未改动）");
      expect(result.stdout).toContain("标签：（无）");
      expect(result.stdout).toContain("来源：（无）");
      expect(result.stdout).toContain("创建者：-");
      expect(result.stdout).not.toContain(dir);
    });
  });

  it("returns the metadata envelope under --json", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const result = await runIn(dir, ["meta", "a.html", "--json"]);

      expect(result.code).toBe(0);
      const body = data(result);
      expect(fieldOf(body, "path")).toBe("a.html");
      expect(fieldOf(body, "tags")).toEqual([]);
      expect(fieldOf(body, "sourceUrl")).toBeNull();
      expect(fieldOf(body, "createdBy")).toBeNull();
      expect(fieldOf(body, "savedAt")).toBeNull();
      expect(fieldOf(body, "changed")).toBe(false);
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
      expect(result.stdout).not.toContain(dir);
    });
  });
});

describe("hr meta · write", () => {
  it("adds repeated --tag values and reads them back", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const written = await runIn(dir, ["meta", "a.html", "--tag", "园艺", "--tag=笔记"]);
      expect(written.code).toBe(0);
      expect(written.stdout).toContain("已更新");
      expect(written.stdout).toContain("标签：园艺, 笔记");
      expect(written.stdout).toContain("创建者：user");

      const read = await runIn(dir, ["meta", "a.html", "--json"]);
      const body = data(read);
      expect(fieldOf(body, "tags")).toEqual(["园艺", "笔记"]);
      expect(fieldOf(body, "createdBy")).toBe("user");
      expect(typeof fieldOf(body, "savedAt")).toBe("string");
    });
  });

  it("removes --untag values case-insensitively", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      await runIn(dir, ["meta", "a.html", "--tag", "Draft", "--tag", "keep"]);
      const result = await runIn(dir, ["meta", "a.html", "--untag", "draft", "--json"]);

      expect(result.code).toBe(0);
      expect(fieldOf(data(result), "tags")).toEqual(["keep"]);
      expect(fieldOf(data(result), "changed")).toBe(true);
    });
  });

  it("sets --source-url and clears it with --clear-source-url", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const set = await runIn(dir, ["meta", "a.html", "--source-url", "https://example.com/page"]);
      expect(set.code).toBe(0);
      expect(set.stdout).toContain("来源：https://example.com/page");

      const cleared = await runIn(dir, ["meta", "a.html", "--clear-source-url", "--json"]);
      expect(fieldOf(data(cleared), "sourceUrl")).toBeNull();
      expect(fieldOf(data(cleared), "changed")).toBe(true);
    });
  });

  it("reports changed:false when the same tags are written again", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      await runIn(dir, ["meta", "a.html", "--tag", "x"]);
      const again = await runIn(dir, ["meta", "a.html", "--tag", "x"]);
      expect(again.code).toBe(0);
      expect(again.stdout).toContain("未改动");
    });
  });

  it("mixes --tag/--untag/--source-url in one write", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      await runIn(dir, ["meta", "a.html", "--tag", "keep", "--tag", "drop"]);
      const result = await runIn(dir, [
        "meta",
        "a.html",
        "--untag",
        "drop",
        "--tag",
        "新",
        "--source-url=https://r.test",
        "--json",
      ]);
      const body = data(result);
      expect(fieldOf(body, "tags")).toEqual(["keep", "新"]);
      expect(fieldOf(body, "sourceUrl")).toBe("https://r.test/");
    });
  });
});

describe("hr meta · paths and errors", () => {
  it("handles a Chinese and a space-carrying file name", async () => {
    await withTempDir(async (dir) => {
      seed(dir, "我的 文档.html");
      const result = await runIn(dir, ["meta", "我的 文档.html", "--tag", "读"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("meta 我的 文档.html（已更新）");
      expect(result.stdout).toContain("标签：读");
    });
  });

  it("exits 2 on usage errors — missing file, extras, conflicting flags, unknown flag", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      for (const argv of [
        ["meta"],
        ["meta", "a.html", "b.html"],
        ["meta", "a.html", "--source-url", "https://x", "--clear-source-url"],
        ["meta", "a.html", "--bogus"],
        ["meta", "a.html", "--tag"],
      ]) {
        const result = await runIn(dir, argv);
        expect(result.code).toBe(2);
        expect(result.stdout).toBe("");
      }
    });
  });

  it("exits 1 when core rejects a bad source URL", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const result = await runIn(dir, ["meta", "a.html", "--source-url", "javascript:x", "--json"]);
      expect(result.code).toBe(1);
      const errLine = parseJsonLine(result.stdout);
      expect(fieldOf(errLine, "ok")).toBe(false);
      expect(fieldOf(errLine, "code")).toBe("invalid_payload");
    });
  });

  it("warns on stderr when the table is corrupt but still answers", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      mkdirSync(join(dir, ".hreader"), { recursive: true });
      writeFileSync(join(dir, ".hreader", "meta.json"), "{broken", "utf8");

      const result = await runIn(dir, ["meta", "a.html"]);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("doc_meta_corrupt");
      expect(result.stdout).toContain("标签：（无）");
    });
  });

  it("caps a long tag list in human mode and keeps the count", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const tags = ["一".repeat(40), "二".repeat(40), "三".repeat(40)];
      const args = ["meta", "a.html", ...tags.flatMap((tag) => ["--tag", tag])];
      const result = await runIn(dir, args);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("…（共 3 个）");
    });
  });

  it("exits 3 for a missing document — not_a_file is the IO tier", async () => {
    await withTempDir(async (dir) => {
      const result = await runIn(dir, ["meta", "missing.html", "--json"]);
      expect(result.code).toBe(3);
      expect(fieldOf(parseJsonLine(result.stdout), "code")).toBe("not_a_file");
    });
  });
});
