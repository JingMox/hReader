// This layer covers `hr search <query>` end to end — one result per line in human mode,
// the {results,total,truncated,diagnostics} envelope under --json, and usage exit codes.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { serializeSidecarFile } from "@hreader/core";

import { fieldOf, listOf, parseJsonLine, withTempDir } from "./harness";
import { runIn, type Captured } from "./support/capture";

const DOC = (title: string, body: string): string =>
  `<!doctype html><html><head><title>${title}</title></head><body><p>${body}</p></body></html>`;

const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");

/** Seed a sidecar store the way `.hreader/annotations/` expects: sha1(relPath).json. */
const seedSidecar = (dir: string, file: string, note: string): void => {
  const annotationsDir = join(dir, ".hreader", "annotations");
  mkdirSync(annotationsDir, { recursive: true });
  writeFileSync(
    join(annotationsDir, `${sha1(file)}.json`),
    serializeSidecarFile(file, [
      {
        id: "an-deadbeef",
        selector: "body > p:nth-of-type(1)",
        anchor: { exact: "机油", prefix: "", suffix: "", start: 0 },
        note,
        status: "pending",
        createdAt: "2026-01-01T00:00:00.000Z",
        author: "user",
        replies: [],
      },
    ]),
    "utf8",
  );
};

const data = (result: Captured): Record<string, unknown> =>
  fieldOf(parseJsonLine(result.stdout), "data") as Record<string, unknown>;

describe("hr search", () => {
  it("prints one result per line in human mode", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "a.html"), DOC("维修", "摩托车 发动机 保养"));
      const result = await runIn(dir, ["search", "摩托车"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("a.html");
      expect(result.stdout).toContain("[文档]");
      expect(result.stdout).toContain("摩托车");
    });
  });

  it("marks annotation hits as 批注 with the id", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "a.html"), DOC("维修", "换了机油"));
      seedSidecar(dir, "a.html", "下次换全合成机油");
      const result = await runIn(dir, ["search", "全合成"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("a.html");
      expect(result.stdout).toContain("[批注 an-deadbeef]");
    });
  });

  it("returns the result envelope under --json", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "a.html"), DOC("维修", "摩托车 发动机"));
      const result = await runIn(dir, ["search", "摩托车", "--json"]);
      expect(result.code).toBe(0);
      const body = data(result);
      const results = listOf(body["results"]);
      expect(results.length).toBe(1);
      expect(fieldOf(results[0], "path")).toBe("a.html");
      expect(fieldOf(results[0], "kind")).toBe("doc");
      expect(fieldOf(body, "total")).toBe(1);
      expect(fieldOf(body, "truncated")).toBe(false);
      expect(fieldOf(body, "combine")).toBe("and");
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
      // No absolute host path on the wire.
      expect(result.stdout).not.toContain(dir);
    });
  });

  it("reports combine or under --json when AND found nothing", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "a.html"), DOC("维修", "摩托车 发动机"));
      const result = await runIn(dir, ["search", "摩托车 电瓶", "--json"]);
      expect(result.code).toBe(0);
      const body = data(result);
      expect(fieldOf(body, "combine")).toBe("or");
      expect(listOf(body["results"]).length).toBe(1);
    });
  });

  it("exits 2 on a missing query and a bad --limit", async () => {
    await withTempDir(async (dir) => {
      for (const argv of [
        ["search"],
        ["search", "摩托", "--limit", "0"],
        ["search", "摩托", "--limit", "abc"],
      ]) {
        const result = await runIn(dir, argv);
        expect(result.code).toBe(2);
        expect(result.stdout).toBe("");
      }
    });
  });

  it("honors --limit and writes rebuild diagnostics to stderr in human mode", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "a.html"), DOC("维修", "摩托车 发动机"));
      writeFileSync(join(dir, "b.html"), DOC("账本", "摩托车 支出"));
      const limited = await runIn(dir, ["search", "摩托车", "--json", "--limit", "1"]);
      expect(limited.code).toBe(0);
      const body = data(limited);
      expect(listOf(body["results"]).length).toBe(1);
      expect(fieldOf(body, "total")).toBe(2);

      // A corrupt index rebuilds — the diagnostic warns on stderr, stdout stays clean.
      mkdirSync(join(dir, ".hreader", "index"), { recursive: true });
      writeFileSync(join(dir, ".hreader", "index", "search.json"), "{ nope", "utf8");
      const rebuilt = await runIn(dir, ["search", "摩托车"]);
      expect(rebuilt.code).toBe(0);
      expect(rebuilt.stderr).toContain("重建");
      expect(rebuilt.stdout).toContain("a.html");
    });
  });

  it("exits 1 when core rejects an over-length query", async () => {
    await withTempDir(async (dir) => {
      const result = await runIn(dir, ["search", "检".repeat(201), "--json"]);
      expect(result.code).toBe(1);
      const errLine = parseJsonLine(result.stdout);
      expect(fieldOf(errLine, "ok")).toBe(false);
      expect(fieldOf(errLine, "code")).toBe("invalid_request");
    });
  });
});
