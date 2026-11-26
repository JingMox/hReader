// This layer covers `hr export --out` escape judgments (four escape shapes + "nothing lands" + existing target still reports 3); no Chrome.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";

import { ARTICLE } from "./export-print-fixtures";
import { fieldOf, parseJsonLine, runCli, withTempDir } from "./harness";

/**
 * The escape landing spot must be **unique**: `$TMPDIR/escape.html` is a fixed name shared by several test
 * files — one real write turns another file's "should not exist" case red. Cases leave no dirty files either.
 */
const escapeNameOf = (stem: string): string =>
  `hr-escape-${stem}-${String(process.pid)}-${String(Date.now())}.html`;

const runOutOf = (dir: string, out: string, extra: readonly string[] = []) =>
  runCli(["export", "doc.html", "--out", out, "--json", ...extra, "--workspace", dir], {
    cwd: dir,
  });

/** Two assertions together: exit code/error code correct, and **not one byte landed on disk**. */
const expectEscapedOf = (
  result: { readonly code: number | null; readonly stdout: string },
  target: string,
): void => {
  expect(result.code).toBe(3);
  expect(fieldOf(parseJsonLine(result.stdout), "code")).toBe("path_outside_workspace");
  expect(existsSync(target)).toBe(false);
  expect(() => readFileSync(target)).toThrow(/ENOENT/u);
};

/** A sibling directory outside the workspace: all escape targets live here; deleted wholesale after use. */
const withSibling = async (run: (sibling: string) => Promise<void>): Promise<void> => {
  const sibling = mkdtempSync(join(tmpdir(), "hr-escape-sib-"));
  try {
    await run(sibling);
  } finally {
    rmSync(sibling, { recursive: true, force: true });
  }
};

const seed = (dir: string): void => {
  writeFileSync(join(dir, "doc.html"), ARTICLE);
};

/**
 * `isInside` uses path-segment boundaries while `startsWith` uses string prefixes: only a "sibling sharing a
 * prefix" (`w` vs `w-evil`) separates them. `..` is already normalized by Node, so a prefix comparison is
 * equivalent to `isInside` on those inputs.
 */
const withPrefixPair = async (
  run: (workspace: string, evil: string) => Promise<void>,
): Promise<void> => {
  const base = mkdtempSync(join(tmpdir(), "hr-escape-prefix-"));
  try {
    const workspace = join(base, "w");
    const evil = join(base, "w-evil");
    mkdirSync(workspace);
    mkdirSync(evil);
    writeFileSync(join(workspace, "doc.html"), ARTICLE);
    await run(workspace, evil);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
};

describe("hr export · --out relative escapes", () => {
  it("should refuse `../x.html` and never create it", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const name = escapeNameOf("rel");
      try {
        expectEscapedOf(await runOutOf(dir, `../${name}`), join(dir, "..", name));
      } finally {
        rmSync(join(dir, "..", name), { force: true });
      }
    });
  });

  // The target **already exists**: the escape check must run before `file_exists` (exit 1), or both code and exit code are wrong.
  it("should still say path_outside_workspace when the outside target exists", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const name = escapeNameOf("exists");
      const target = join(dir, "..", name);
      writeFileSync(target, "旧");
      try {
        const result = await runOutOf(dir, `../${name}`);
        expect(result.code).toBe(3);
        expect(fieldOf(parseJsonLine(result.stdout), "code")).toBe("path_outside_workspace");
        // Not overwritten: the escape check neither passed as "write allowed" nor treated the outside file as its own target.
        expect(readFileSync(target, "utf8")).toBe("旧");
      } finally {
        rmSync(target, { force: true });
      }
    });
  });
});

describe("hr export · --out absolute paths", () => {
  it("should refuse an absolute --out outside the default workspace", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const target = join(tmpdir(), escapeNameOf("abs"));
      try {
        // No `--workspace` passed: it defaults to cwd, and another temp dir under `$TMPDIR` is still outside it.
        expectEscapedOf(await runOutOf(dir, target), target);
      } finally {
        rmSync(target, { force: true });
      }
    });
  });
});

describe("hr export · --out traversal normalization", () => {
  it("should refuse `dir/../sibling/x.html`", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      await withSibling(async (sibling) => {
        const name = escapeNameOf("traverse");
        const result = await runOutOf(dir, `../${basename(sibling)}/${name}`);
        expectEscapedOf(result, join(sibling, name));
      });
    });
  });

  // The judgment looks at the normalized landing spot, not the string prefix: `..` walking back inside must pass.
  it("should allow escaping and coming back into the workspace", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      await withSibling(async (sibling) => {
        const back = `../${basename(sibling)}/../${basename(dir)}/back.html`;
        expect((await runOutOf(dir, back)).code).toBe(0);
        expect(existsSync(join(dir, "back.html"))).toBe(true);
      });
    });
  });
});

describe("hr export · --out shared-prefix sibling dir", () => {
  it("should refuse `<base>/w-evil/x.html` and leave the existing file untouched", async () => {
    await withPrefixPair(async (workspace, evil) => {
      const target = join(evil, "x.html");
      writeFileSync(target, "旧");
      const result = await runOutOf(workspace, join(evil, "x.html"));
      expect(result.code).toBe(3);
      expect(fieldOf(parseJsonLine(result.stdout), "code")).toBe("path_outside_workspace");
      // Untouched, unprobed, unoverwritten: a shared prefix must not make the escape check treat the outside file as its own.
      expect(readFileSync(target, "utf8")).toBe("旧");
    });
  });

  it("should refuse the same prefix sibling even when the target does not exist", async () => {
    await withPrefixPair(async (workspace, evil) => {
      const target = join(evil, "new.html");
      expectEscapedOf(await runOutOf(workspace, target), target);
      expect(readdirSync(evil)).toEqual([]);
    });
  });
});

describe("hr export · --out symlink", () => {
  it("should refuse a workspace-internal symlink that points outside", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      await withSibling(async (outside) => {
        symlinkSync(outside, join(dir, "link"));
        const result = await runOutOf(dir, "link/x.html");
        expect(result.code).toBe(3);
        expect(fieldOf(parseJsonLine(result.stdout), "code")).toBe("path_outside_workspace");
        expect(readdirSync(outside)).toEqual([]);
      });
    });
  });
});
