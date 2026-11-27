// This layer owns: the integration tests' globalSetup — prove the dist
// artifacts exist before running (journeys test the packaged artifacts, not
// src), and sweep hr-it-* sandbox dirs left by an interrupted previous run; no
// business assertions.

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  setup as leakGateSetup,
  teardown as leakGateTeardown,
} from "../leak-guard/global-setup.ts";
import { APP_DIR, CLI_BIN, MCP_BIN } from "./harness/env.ts";

/** The artifacts the suites actually use: the real CLI/MCP binaries + the reader static face (the daemon's --app-dir). */
const REQUIRED_ARTIFACTS: readonly { readonly path: string; readonly what: string }[] = [
  { path: CLI_BIN, what: "packages/cli's dist/cli.mjs" },
  { path: MCP_BIN, what: "packages/mcp-server's dist/main.js" },
  { path: join(APP_DIR, "index.html"), what: "packages/app's dist/index.html" },
  { path: join(APP_DIR, "assets", "main.js"), what: "packages/app's dist/assets/main.js" },
];

const SANDBOX_PREFIX = "hr-it-";
const started = Date.now();

export const setup = (): void => {
  // Create this run's leak registry + sweep orphans of dead earlier runs, then
  // do the artifact check.
  leakGateSetup();
  const missing = REQUIRED_ARTIFACTS.filter(({ path }) => !existsSync(path));
  if (missing.length > 0) {
    throw new Error(
      `integration tests run the packaged artifacts; these dist files are missing: ${missing.map(({ what }) => what).join(", ")}. Run pnpm build first.`,
    );
  }
};

export const teardown = (): void => {
  // Only sweep hr-it-* dirs older than this run's start: same-prefix live dirs
  // of parallel agents stay untouched; this run's own sandboxes are returned
  // normally by each suite's afterAll cleanup.
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith(SANDBOX_PREFIX)) continue;
    const dir = join(tmpdir(), name);
    try {
      if (statSync(dir).mtimeMs < started) rmSync(dir, { recursive: true, force: true });
    } catch {
      // The dir was reclaimed by another process between scan and delete: not a failure.
    }
  }
  // Final verdict: a registered test child that is still alive is a leak —
  // kill it and fail the run.
  leakGateTeardown();
};
