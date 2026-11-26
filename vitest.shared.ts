// Test conventions shared by the root vitest.config.ts and each package's vitest.config.ts;
// single-package `pnpm -F <pkg> test` and root `pnpm test` share the same resolution and
// timeouts.
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const fromRepoRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

// package name → source entry: tests and runtime resolve to the same source, avoiding class-identity drift between dist artifacts and sources.
const ALIASES = [
  "@hreader/core",
  "@hreader/renderer-html",
  "@hreader/app",
  "@hreader/mcp-server",
] as const;

export const packageAliases: Record<string, string> = Object.fromEntries(
  ALIASES.map((name) => [
    name,
    fromRepoRoot(`./packages/${name.slice("@hreader/".length)}/src/index.ts`),
  ]),
);

// Two workers everywhere. Locally, the default pool (about one per core) with v8 coverage
// exhausts a 16 GB machine. On CI, the 4-vCPU runner is oversubscribed because many tests
// spawn CLI and Chrome subprocesses on top of each worker; the starved main process then
// misses worker RPC deadlines ("Timeout calling onTaskUpdate"). This is a throughput cap,
// not a relaxed gate.
const MAX_WORKERS = 2;
// CLI-case timeouts are managed by tests/harness.ts itself: a 10s hard timeout per runCli plus a
// 10s withTempDir backstop. The vitest default 5s sits below both guards, so under parallel load it
// always fires first and buries a diagnosable failure under "Test timed out in 5000ms". 30s ≈ the
// legal budget of ~3 CLI calls.
const TEST_TIMEOUT_MS = 30_000;

export const packageTest = {
  include: ["tests/**/*.test.ts"],
  maxWorkers: MAX_WORKERS,
  testTimeout: TEST_TIMEOUT_MS,
};

export const definePackageConfig = () =>
  defineConfig({ resolve: { alias: packageAliases }, test: packageTest });
