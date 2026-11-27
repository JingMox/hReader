// dependency-cruiser gate: git-ignored build artifacts under packages/desktop/src-tauri/
// (resources/app/, resources/cli/, target/) must never enter the cruise. prepare-resources
// copies a bundled cli.mjs there whose optional imports (yauzl, proxy-agent) resolve
// nowhere — scanned as sources they produce false no-unresolvable reds that mask real
// violations. The test rebuilds a minimal package tree in a temp dir and runs the real
// CLI against the real config, same entry point `pnpm depcruise` uses.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const REPO_ROOT = decodeURIComponent(new URL("../../../", import.meta.url).pathname);
const CONFIG = join(REPO_ROOT, ".dependency-cruiser.cjs");
// The package's `exports` hides ./bin/* and ./package.json; go through the root
// node_modules symlink (a direct devDependency) instead of a specifier resolution.
const DEPCRUISE_BIN = join(
  REPO_ROOT,
  "node_modules",
  "dependency-cruiser",
  "bin",
  "dependency-cruise.mjs",
);

/** Stand-ins for the real artifacts: bundled files importing deps nothing can resolve. */
const ARTIFACT_FILES: Readonly<Record<string, string>> = {
  "packages/desktop/src-tauri/resources/cli/cli.mjs":
    'const dep = await import("hr-gate-unresolvable-cli");\nexport default dep;\n',
  "packages/desktop/src-tauri/resources/app/assets/app.js":
    'import { leaked } from "hr-gate-unresolvable-app";\nexport { leaked };\n',
  "packages/desktop/src-tauri/target/release/build/bundle/out.js":
    'require("hr-gate-unresolvable-target");\n',
};

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface Cruise {
  readonly status: number | null;
  readonly output: string;
}

/** A throwaway repo root: artifact files plus caller-supplied sources, cruised as `packages`. */
const sandboxOf = (extraFiles: Readonly<Record<string, string>>): (() => Cruise) => {
  const dir = mkdtempSync(join(tmpdir(), "hr-depcruise-gate-"));
  dirs.push(dir);
  writeFileSync(join(dir, "tsconfig.json"), "{}\n");
  for (const [name, body] of Object.entries({ ...ARTIFACT_FILES, ...extraFiles })) {
    const target = join(dir, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  return () => {
    const result = spawnSync(process.execPath, [DEPCRUISE_BIN, "--config", CONFIG, "packages"], {
      cwd: dir,
      encoding: "utf8",
    });
    return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
  };
};

describe("dependency-cruiser gate", () => {
  it("should not scan git-ignored desktop build artifacts", () => {
    const run = sandboxOf({
      "packages/probe/src/ok.ts": 'import { util } from "./util";\nexport { util };\n',
      "packages/probe/src/util.ts": "export const util = 1;\n",
    });
    const { status, output } = run();
    expect(output).toContain("no dependency violations");
    expect(status).toBe(0);
  }, 60_000);

  it("should flag unresolvable imports directly under resources/", () => {
    // .gitignore only covers resources/app/ and resources/cli/ — a file tracked directly in
    // resources/ is real input, not generated output, so the cruise must see it.
    const run = sandboxOf({
      "packages/desktop/src-tauri/resources/stray.mjs":
        'import { leaked } from "hr-gate-unresolvable-stray";\nexport { leaked };\n',
      "packages/probe/src/util.ts": "export const util = 1;\n",
    });
    const { status, output } = run();
    expect(status).not.toBe(0);
    expect(output).toContain("packages/desktop/src-tauri/resources/stray.mjs");
  }, 60_000);

  it("should still flag unresolvable imports in real source files", () => {
    const run = sandboxOf({
      "packages/probe/src/bad.ts":
        'import { gone } from "hr-gate-unresolvable-src";\nexport { gone };\n',
    });
    const { status, output } = run();
    expect(status).not.toBe(0);
    expect(output).toContain("packages/probe/src/bad.ts");
    expect(output).not.toContain("src-tauri");
  }, 60_000);
});
