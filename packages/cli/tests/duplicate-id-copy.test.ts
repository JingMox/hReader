// Copy unification for duplicate `data-hr-id`.
//
// The old copy said "`read`/`patch` will only hit the first", while the implementation **exits 2 before locating at all** (`duplicate_id`) —
// the behavior the message lets you predict is the opposite of reality; this is the only contract a user can read, so both sides are pinned:
// ① the stale phrasing "只会命中第一个" has **zero hits** under `packages/*/src` and `docs` (comments/messages/docs all count);
// ② the new message must give the executable step (`先跑 hr normalize <file> --write`) and state that the duplicate is unreachable;
// ③ exit code 2 (usage/content error), not 1 (target not found) — it never even entered locating.
//
// Assertions pin external observables: source file contents, the `--json` envelope, exit codes.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { fieldOf, parseJsonLine, runCli, withTempDir } from "./harness";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const OBSOLETE = "只会命中第一个";

/** Scope of copy unification: implementation and docs (archived review records do not count — they record pre-change facts). */
const SCOPES = ["packages/core/src", "packages/cli/src", "docs"] as const;

const filesUnder = (dir: string): readonly string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return /\.(ts|md)$/.test(entry.name) ? [path] : [];
  });

const DUP = [
  "<!doctype html>",
  '<html data-hr-id="hr-h"><head data-hr-id="hr-head"><title data-hr-id="hr-title">t</title></head>',
  '<body data-hr-id="hr-body"><article data-hr-id="hr-root">',
  '<p data-hr-id="hr-x">第一处</p>',
  '<p data-hr-id="hr-x">第二处</p>',
  "</article></body></html>",
].join("\n");

describe("zero hits for stale copy", () => {
  it.each(SCOPES)("should not keep the obsolete wording under %s", (scope) => {
    const offenders = filesUnder(join(ROOT, scope)).filter((path) =>
      readFileSync(path, "utf8").includes(OBSOLETE),
    );

    expect(offenders).toEqual([]);
  });
});

describe("the duplicate_id message gives the executable step", () => {
  it("should tell the user to run `hr normalize <file> --write` (read)", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(`${dir}/a.html`, DUP);
      const result = await runCli(["read", "a.html", "hr-x", "--json"], { cwd: dir });
      const parsed = parseJsonLine(result.stdout);
      const message = String(fieldOf(parsed, "message"));

      expect(result.code).toBe(2);
      expect(fieldOf(parsed, "code")).toBe("duplicate_id");
      expect(message).toContain('两个元素共用 data-hr-id "hr-x"');
      expect(message).toContain("永远读不到");
      // Path shape differs per command path (read reports realpath, patch reports the user's relative input): pin "the copy-pasteable command" itself.
      expect(message).toMatch(/先跑 hr normalize \S*a\.html --write/);
      expect(message).not.toContain(OBSOLETE);
    });
  });

  it("should refuse patch with the same code and wording", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(`${dir}/a.html`, DUP);
      const result = await runCli(["patch", "a.html", "hr-x", "--action", "delete", "--json"], {
        cwd: dir,
      });
      const parsed = parseJsonLine(result.stdout);
      const message = String(fieldOf(parsed, "message"));

      expect(result.code).toBe(2);
      expect(fieldOf(parsed, "code")).toBe("duplicate_id");
      expect(message).toContain("先跑 hr normalize a.html --write");
      expect(message).not.toContain(OBSOLETE);
    });
  });
});
