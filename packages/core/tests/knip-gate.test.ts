// knip gate: same gitignore boundary as the depcruise gate. Generated desktop artifacts
// under packages/desktop/src-tauri/ (resources/app/, resources/cli/, target/) must stay
// ignored — knip would otherwise count bundled output as unused files — while a file
// tracked directly in resources/ is real input knip must keep scanning. The test rebuilds
// a minimal workspace tree in a temp dir and runs the real CLI against the real knip.json,
// same entry point `pnpm knip` uses.

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const REPO_ROOT = decodeURIComponent(new URL("../../../", import.meta.url).pathname);
const CONFIG = join(REPO_ROOT, "knip.json");
// The package's `exports` only exposes "." and "./session"; go through the root
// node_modules symlink (a direct devDependency) instead of a specifier resolution.
const KNIP_BIN = join(REPO_ROOT, "node_modules", "knip", "bin", "knip.js");

/** Stand-ins for the real artifacts: generated output knip must never see. */
const ARTIFACT_FILES: Readonly<Record<string, string>> = {
  "packages/desktop/src-tauri/resources/cli/cli.mjs":
    'const dep = await import("hr-gate-unresolvable-cli");\nexport default dep;\n',
  "packages/desktop/src-tauri/resources/app/assets/app.js":
    'import { leaked } from "hr-gate-unresolvable-app";\nexport { leaked };\n',
  "packages/desktop/src-tauri/target/release/build/bundle/out.js":
    'require("hr-gate-unresolvable-target");\n',
};

// knip discovers workspaces from package.json#workspaces; the desktop package only needs a
// manifest plus one real entry file (webview/*.js is its entry pattern in knip.json).
const BASE_FILES: Readonly<Record<string, string>> = {
  "package.json": '{"name":"probe","private":true,"version":"0.0.0","workspaces":["packages/*"]}\n',
  "packages/desktop/package.json": '{"name":"@hreader/desktop","private":true,"version":"0.0.0"}\n',
  "packages/desktop/webview/app.js": "export const app = 1;\n",
};

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface Knip {
  readonly status: number | null;
  readonly output: string;
}

/** A throwaway repo root: the real knip.json over base + artifact + caller-supplied files. */
const sandboxOf = (extraFiles: Readonly<Record<string, string>>): (() => Knip) => {
  const dir = mkdtempSync(join(tmpdir(), "hr-knip-gate-"));
  dirs.push(dir);
  cpSync(CONFIG, join(dir, "knip.json"));
  for (const [name, body] of Object.entries({
    ...BASE_FILES,
    ...ARTIFACT_FILES,
    ...extraFiles,
  })) {
    const target = join(dir, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  return () => {
    const result = spawnSync(process.execPath, [KNIP_BIN], { cwd: dir, encoding: "utf8" });
    return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
  };
};

describe("knip gate", () => {
  it("should not scan git-ignored desktop build artifacts", () => {
    const { status, output } = sandboxOf({})();
    expect(output).not.toContain("src-tauri");
    expect(status).toBe(0);
  }, 60_000);

  it("should flag an unused file directly under resources/", () => {
    // .gitignore only covers resources/app/ and resources/cli/ — a file tracked directly in
    // resources/ is real input, not generated output, so knip must see it.
    const { status, output } = sandboxOf({
      "packages/desktop/src-tauri/resources/stray.mjs":
        'import { leaked } from "hr-gate-unresolvable-stray";\nexport { leaked };\n',
    })();
    expect(status).not.toBe(0);
    expect(output).toContain("packages/desktop/src-tauri/resources/stray.mjs");
  }, 60_000);
});
