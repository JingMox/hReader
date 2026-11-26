// Stryker `buildCommand`: runs once in each sandbox before the initial test run.
// Two jobs:
// 1) the sandbox copy rewrites all permissions to 0644 — restore +x on deliverables that get
//    spawned or whose shebang is asserted;
// 2) node_modules is a symlink, which pnpm 10 judges "foreign" and triggers a
//    verify-deps-before-run auto-install (aborts outright without a TTY) — append the switch that
//    turns it off to the sandbox's pnpm-workspace.yaml.
// Workspace config is touched only when running inside a .stryker-tmp sandbox; chmod is
// idempotent and safe anywhere.

import { appendFileSync, chmodSync, readFileSync } from "node:fs";

const EXEC_FILES = [
  "packages/cli/fixtures/fake-chrome.mjs",
  "skills/hreader/scripts/hr.mjs",
  "packages/mcp-server/dist/main.js",
  "scripts/build-site.sh",
  "scripts/pack-skill.mjs",
  "packages/desktop/scripts/prepare-resources.mjs",
];

for (const file of EXEC_FILES) {
  try {
    chmodSync(file, 0o755);
  } catch {
    // skip files absent from the sandbox copy
  }
}

const workspaceFile = "pnpm-workspace.yaml";
const workspace = readFileSync(workspaceFile, "utf8");
if (!workspace.includes("verifyDepsBeforeRun")) {
  appendFileSync(workspaceFile, "verifyDepsBeforeRun: false\n");
}
