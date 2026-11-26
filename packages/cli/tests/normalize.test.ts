// This layer covers `hr normalize` — ids must be injected before outline/read/patch/serve work.
//
// Three user-visible facts, none optional:
//   1. Without `--write` it only prints (the result goes to stdout; the file loses not a byte);
//   2. `--write` lands on disk, and **existing ids stay byte-identical**; a second run reports `injected=0`, bytes unchanged (idempotent);
//   3. With no `<article>` it says plainly "this is not a normalizable document" (`invalid_document`, exit 1) — no silent no-op.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checked } from "./cli-support";
import { fieldOf, parseJsonLine, runCli, textOf, withTempDir, type CliResult } from "./harness";

/** A handwritten document: cover + 3 chapters + one section, **no** `data-hr-id` at all (real user material). */
export const HANDWRITTEN = [
  "<!doctype html>",
  "<html><head><title>季度复盘</title></head><body>",
  '<header class="cover"><h1>季度复盘</h1><p>封面副标题</p></header>',
  "<article>",
  "<h1>第一章 把发布节奏拉回来</h1><p>第一章正文。</p>",
  "<h2>1.1 先把回滚路径跑通</h2><p>小节正文。</p>",
  "<h1>第二章 评审拆成「必须」与「可以」</h1><p>第二章正文。</p>",
  "<h1>第三章 下一季度的三件事</h1><p>第三章正文。</p>",
  "</article>",
  "</body></html>",
  "",
].join("\n");

const seed = (dir: string, html = HANDWRITTEN): string => {
  const path = join(dir, "doc.html");
  writeFileSync(path, html);
  return path;
};

const normalize = (dir: string, extra: readonly string[] = []): Promise<CliResult> =>
  runCli(["normalize", "doc.html", ...extra], { cwd: dir });

/** The `--json` `data` field (no `as`: assertions go through `textOf`/`Number`). */
const dataOf = (result: CliResult): unknown => fieldOf(parseJsonLine(result.stdout), "data");

describe("hr normalize · print without write", () => {
  it("should report what it would inject on stdout without touching the file", async () => {
    await withTempDir(async (dir) => {
      const path = seed(dir);
      const before = readFileSync(path, "utf8");

      const result = checked(await normalize(dir, ["--json"]));
      const data = dataOf(result);

      expect(result.code).toBe(0);
      expect(fieldOf(data, "needsNormalize")).toBe(true);
      expect(Number(fieldOf(data, "injected"))).toBeGreaterThan(0);
      // The printed html is "what it looks like with ids injected" — the user can see every node's id directly.
      expect(textOf(fieldOf(data, "html"))).toContain("data-hr-id=");
      expect(textOf(fieldOf(data, "html"))).toContain("第一章 把发布节奏拉回来");
      // The key point: without --write, nothing lands on disk.
      expect(readFileSync(path, "utf8")).toBe(before);
    });
  });

  it("should keep the human line on one line and say how many ids it added", async () => {
    await withTempDir(async (dir) => {
      seed(dir);

      const result = checked(await normalize(dir, ["--write"]));

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toMatch(/^normalized .*doc\.html \(\+\d+ ids, \d+ bytes\)\n$/u);
    });
  });
});

describe("hr normalize --write · idempotent", () => {
  it("should write ids to disk and report injected 0 on the second run", async () => {
    await withTempDir(async (dir) => {
      const path = seed(dir);
      expect(checked(await normalize(dir, ["--write", "--json"])).code).toBe(0);
      const afterFirst = readFileSync(path, "utf8");
      expect(afterFirst).toContain("data-hr-id=");

      const second = checked(await normalize(dir, ["--write", "--json"]));

      // Idempotency is this command's reason to exist: otherwise a rerun swaps every id and all previously handed-out ids die.
      expect(fieldOf(dataOf(second), "needsNormalize")).toBe(false);
      expect(fieldOf(dataOf(second), "injected")).toBe(0);
      expect(readFileSync(path, "utf8")).toBe(afterFirst);
    });
  });

  it("should leave every id the document already carries untouched", async () => {
    await withTempDir(async (dir) => {
      seed(
        dir,
        '<article data-hr-id="keep-a"><h2 data-hr-id="keep-b">已有 id</h2><p>没 id</p></article>',
      );

      expect(checked(await normalize(dir, ["--write"])).code).toBe(0);
      const written = readFileSync(join(dir, "doc.html"), "utf8");

      expect(written).toContain('data-hr-id="keep-a"');
      expect(written).toContain('data-hr-id="keep-b"');
      expect((written.match(/data-hr-id=/gu) ?? []).length).toBe(3);
    });
  });
});

describe("hr normalize · not a document", () => {
  it("should reject a file without <article> as invalid_document (exit 1)", async () => {
    await withTempDir(async (dir) => {
      seed(dir, "just plain text");

      const result = checked(await normalize(dir, ["--json"]));
      const envelope = parseJsonLine(result.stdout);

      expect(result.code).toBe(1);
      expect(fieldOf(envelope, "ok")).toBe(false);
      expect(fieldOf(envelope, "code")).toBe("invalid_document");
      expect(textOf(fieldOf(envelope, "message"))).toContain("<article>");
    });
  });

  it("should name the file and the next step in human mode", async () => {
    await withTempDir(async (dir) => {
      seed(dir, "");

      const result = checked(await normalize(dir));

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("<article>");
      // Internal function names like `injectNodeIds` must not reach the user.
      expect(result.stderr).not.toContain("injectNodeIds");
    });
  });
});
