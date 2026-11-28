// Dedicated Vitest config for cross-package integration tests (tests/integration/**) —
// journey-level verification on real dist artifacts + real Chrome; excluded from `pnpm test`
// (unit) and the coverage gate, run separately in CI.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    // Same HOME isolation as the unit suite (issue #58): spawned daemons/CLIs inherit the
    // worker's env, so a home-resolution fallback lands in a per-worker temp dir.
    setupFiles: ["tests/setup/isolate-home.ts"],
    // Every suite starts its own daemon/Chrome/temp workspace: running serially makes port and
    // tmpdir reclamation timing predictable (the Vitest equivalent of the old run.ts's
    // serial-per-suite subprocess).
    fileParallelism: false,
    maxWorkers: 1,
    // The slowest case in a suite is desktop --smoke (90s process budget); the unit-level 5s
    // default would false-kill it.
    testTimeout: 120_000,
    // beforeAll starts Chrome + daemon + MCP, costlier than the cases themselves.
    hookTimeout: 120_000,
    // Build-artifact existence check plus cleanup of hr-it-* sandboxes left by an interrupted
    // previous run.
    globalSetup: ["tests/integration/global-setup.ts"],
  },
});
