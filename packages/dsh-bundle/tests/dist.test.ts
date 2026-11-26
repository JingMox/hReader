// The `build`-produced `dist/` must install straight into a host — self-contained (no import of
// `@hreader/core`), no `workspace:` protocol, declaration files carrying the `@deepseek-ai/cordis`
// type merge. It builds the artifact itself before asserting (same as
// `packages/mcp-server/tests/probe.ts`), not relying on a prior `pnpm build`.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";
import { BUILTIN_STYLES } from "@hreader/core";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST_DIR = `${PACKAGE_ROOT}dist`;
const DIST_JS = `${DIST_DIR}/index.js`;
const DIST_DTS = `${DIST_DIR}/index.d.ts`;
const DIST_EVENTS_DTS = `${DIST_DIR}/events.d.ts`;

/** Relative paths and full text of every file under `dist/` (the deliverable is the **whole dist**, not just the two entry files). */
const distFiles = (): { path: string; text: string }[] =>
  readdirSync(DIST_DIR, { recursive: true, encoding: "utf8" })
    .map((path) => join(DIST_DIR, path))
    .filter((path) => statSync(path).isFile())
    .map((path) => ({ path: path.slice(DIST_DIR.length + 1), text: readFileSync(path, "utf8") }));

/** The module name of one `import … from "x"` / `import "x"`. */
const specifiersOf = (text: string): string[] =>
  [...text.matchAll(/(?:from|import)\s+["']([^"']+)["']/gu)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );

/** Reads an export by name (dynamic import yields `any`; everything is narrowed to `unknown` before asserting). */
const exportOf = (module: unknown, name: string): unknown => {
  if (typeof module !== "object" || module === null) throw new Error("dist 没有导出命名空间");
  return Object.entries(module).find(([key]) => key === name)?.[1];
};

beforeAll(() => {
  execFileSync("pnpm", ["-C", PACKAGE_ROOT, "build"], { stdio: "pipe" });
}, 180_000);

describe("dist: the host can load it directly", () => {
  it("should produce js + two d.ts files (events.d.ts carries the module merge)", () => {
    for (const file of [DIST_JS, DIST_DTS, DIST_EVENTS_DTS]) {
      expect(existsSync(file), file).toBe(true);
    }
  });

  it("should contain no runtime import of `@hreader/core` in `dist/index.js`", () => {
    const packed = readFileSync(DIST_JS, "utf8");

    // Once inside a profile's node_modules the workspace protocol cannot resolve, so core must be bundled statically.
    expect(packed).not.toContain("@hreader/core");
    expect(packed).not.toContain("workspace:*");
    expect(packed).not.toContain('from "@deepseek-ai/cordis"');
  });

  it("should really import `apply` out of it (esbuild fixed node builtins' dynamic require)", async () => {
    const loaded: unknown = await import(DIST_JS);

    expect(exportOf(loaded, "apply")).toBeTypeOf("function");
    expect(exportOf(loaded, "inject")).toEqual(["systemPrompt"]);
    expect(exportOf(loaded, "SECTION_ORDER")).toBe(100);
  });

  it('should carry `declare module "@deepseek-ai/cordis"` in the declarations (or users never see the type merge)', () => {
    expect(readFileSync(DIST_EVENTS_DTS, "utf8")).toContain('declare module "@deepseek-ai/cordis"');
  });
});

describe("dist: theme CSS ships with the artifact", () => {
  it("should resolve `dist/styles/<visual>/theme.css` for all three builtin themes", () => {
    // Expectations derive from `BUILTIN_STYLES` (not hand-copied): directory names are `inheritsVisual`
    // (`resolveThemePath`'s criterion, see `builtinThemeDir` in `packages/core/src/style/resource.ts`).
    // The first three presets share the atelier visual, deck-noir is its own directory; a build missing
    // `cp -R ../../styles dist/styles` goes red.
    const visualIds = [...new Set(BUILTIN_STYLES.map((style) => style.inheritsVisual))];
    const stylesDir = join(DIST_DIR, "styles");

    // The bound is a literal: if `visualIds` derived to an empty array, the `for` below would idle and
    // `arrayContaining([])` is always true, degenerating the case to `existsSync(stylesDir)` (deleting
    // `theme.css` would stay green). No `length > 0` either: a change in the derivation criterion (a
    // visual added or dropped) must show up in the assertion.
    expect(visualIds).toEqual(["atelier-editorial", "deck-noir"]);
    expect(existsSync(stylesDir)).toBe(true);
    expect(readdirSync(stylesDir)).toEqual(expect.arrayContaining(visualIds));
    for (const id of visualIds) {
      expect(existsSync(join(stylesDir, id, "theme.css")), id).toBe(true);
    }
  });
});

describe("dist: no uninstallable/unresolvable package names in the deliverable", () => {
  it("should never mention `@hreader/core` or the `workspace:*` protocol across the whole dist (incl. `*.js.map`)", () => {
    // Declaration files are read by the user's tsc too: a single `import type … "@hreader/core"` in
    // `dist/events.d.ts` is enough to throw Cannot find module on a profile install (core is only a
    // workspace devDep). `index.js.map` is deliverable too: `--sources-content=false` keeps only paths
    // and smuggles in no core source. The assertion writes `workspace:*`, not `workspace:`:
    // `readonly workspace: string;` is a field name, not the protocol.
    const offenders = distFiles()
      .filter((file) => file.text.includes("@hreader/core") || file.text.includes("workspace:*"))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
    expect(distFiles().map((file) => file.path)).toEqual(
      expect.arrayContaining(["index.js", "index.d.ts", "events.d.ts"]),
    );
  });

  it('should contain no `from "@deepseek-ai/…"` bare dependency in the declarations (uninstalled means TS2307)', () => {
    // `src/events.ts` has an `import type {}` seed (so this package can see the augmentation chain); it must be wiped clean.
    const offenders = distFiles()
      .filter((file) => file.path.endsWith(".d.ts") && /from\s+["']@deepseek-ai\//u.test(file.text))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  it("should limit bare package names in `dist/index.d.ts` to `@deepseek-ai/*` (everything else relative or node builtin)", () => {
    const bare = specifiersOf(readFileSync(DIST_DTS, "utf8")).filter(
      (specifier) => !specifier.startsWith(".") && !specifier.startsWith("node:"),
    );

    expect(bare.filter((specifier) => !specifier.startsWith("@deepseek-ai/"))).toEqual([]);
  });
});
