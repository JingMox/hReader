// This layer: the theme root `styleDepsOf` points at — every builtin preset's `theme.css` must really sit under it;
// plus the misattribution line of defense for "resources not located at all" (error code + startup WARNING).
// In the source layout core computes it correctly; only bundling / copying out of the repo breaks it. `stdio.test.ts`'s real-artifact case is the main evidence;
// here it is pinned into cheap assertions that can name the missing file directly.

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { BUILTIN_STYLES, HrError, loadStyle, nodeStyleDeps } from "@hreader/core";
import { describe, expect, it } from "vitest";

import {
  firstThemeRootOf,
  styleCandidatesOf,
  styleDepsOf,
  styleRootWarningOf,
} from "../src/style-deps";

/** A path segment guaranteed not to exist: stands in for the "artifact copied outside the repo" layout. */
const ABSENT_ROOT = join(tmpdir(), "hreader-styles-root-that-is-not-there");

const errorOf = (run: () => unknown): unknown => {
  try {
    run();
    return undefined;
  } catch (caught: unknown) {
    return caught;
  }
};

describe("styleDepsOf", () => {
  it("should point the builtin theme root at a directory that holds every preset's theme.css", () => {
    const { stylesRoot } = styleDepsOf("/workspace");
    // After deduping presets' `inheritsVisual`, every visual needs a `styles/<id>/theme.css`;
    // with the theme root right, reskinning works for every id — a wrong root is the bug, not missing files.
    const missing = BUILTIN_STYLES.map((style) => style.inheritsVisual).filter(
      (visualId) => !existsSync(join(stylesRoot, visualId, "theme.css")),
    );

    expect(missing).toEqual([]);
  });
});

describe("styleDepsOf · the whole chain", () => {
  it("should load a builtin preset all the way through, not merely find its theme.css", async () => {
    // "File present" ≠ "chain linked": this step really goes through core's `loadStyle` (reads theme.css + hits the preset spec).
    const { spec } = await loadStyle({ id: "atelier-editorial" }, styleDepsOf("/workspace"));

    expect(spec.id).toBe("atelier-editorial");
    expect(spec.language.persona.length).toBeGreaterThan(0);
  });
});

describe("styleDepsOf · theme resources missing", () => {
  it("should refuse with style_io_failure instead of letting core blame the id", () => {
    const caught = errorOf(() => styleDepsOf("/workspace", ABSENT_ROOT));

    // Misattribution costs more than an error: the style exists — its resources were not located — so it must not be `unknown_style`.
    expect(caught instanceof HrError && caught.code).toBe("style_io_failure");
    // The body only gets the package-relative location (absolute paths must not enter content); the absolute one lives in the startup WARNING.
    expect(caught instanceof Error ? caught.message : "").toContain(
      "styles/atelier-editorial/theme.css",
    );
    expect(caught instanceof Error ? caught.message : "").not.toContain(ABSENT_ROOT);
  });

  it("should warn once at startup and stay silent when the styles are there", () => {
    expect(styleRootWarningOf("/workspace")).toBeUndefined();
    expect(styleRootWarningOf("/workspace", ABSENT_ROOT)).toContain("WARNING 主题资源缺失：");
  });
});

/** Build a fake root with "all theme resources present": the sentinel file must really exist for `firstThemeRootOf` to accept it. */
const themeRootOf = (name: string): string => {
  const root = join(mkdtempSync(join(tmpdir(), `hreader-style-${name}-`)), "styles");
  mkdirSync(join(root, "atelier-editorial"), { recursive: true });
  writeFileSync(join(root, "atelier-editorial", "theme.css"), ":root{}");
  return root;
};

describe("candidate order", () => {
  it("should put the package-local styles first, with core's repo root as the dev fallback", () => {
    const [first, second] = styleCandidatesOf("/workspace");

    // Package-local first: in a release the package copy is the source of truth (reverse the order and this goes red).
    // Exact value asserted, not `toContain("packages/mcp-server/styles")`: any path containing that fragment (including the repo-root copy) passes a substring check.
    expect(first).toBe(fileURLToPath(new URL("../styles/", import.meta.url)));
    // The repo root only covers running from source: it is computed by core; this package does not respell the depth.
    expect(second).toBe(nodeStyleDeps("/workspace").stylesRoot);
  });

  it("should take the first candidate that really has the theme, so the order is load-bearing", () => {
    const packageLocal = themeRootOf("package");
    const repoRoot = themeRootOf("repo");

    // These two pin the **helper-function contract** ("take the first candidate that really has themes"), not production wiring:
    // whether "package-local first" is truly wired is covered black-box by `install-sim.test.ts`'s sentinel arm (writes a sentinel into the package copy; the landing contains the sentinel).
    expect(firstThemeRootOf([packageLocal, repoRoot])).toBe(packageLocal);
    expect(firstThemeRootOf([repoRoot, packageLocal])).toBe(repoRoot);
  });
});
