// 这层管：根目录 vitest.config.ts 与各包 vitest.config.ts 共用的测试约定；
// 单包 `pnpm -F <pkg> test` 与根目录 `pnpm test` 走同一份解析与超时。
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const fromRepoRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

// 包名 → 源码入口：测试与运行期都解析到同一份源码，避免 dist 产物与源码类身份不一致。
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
// CLI 用例的超时由 tests/harness.ts 自己管：每次 runCli 10s 硬超时、withTempDir 10s 兜底。
// vitest 默认 5s 低于这两道守卫，并行有负载时总是它先触发，把可辨认的诊断盖成一句
// "Test timed out in 5000ms"。30s = 约 3 次 CLI 调用的合法预算。
const TEST_TIMEOUT_MS = 30_000;

export const packageTest = {
  include: ["tests/**/*.test.ts"],
  maxWorkers: MAX_WORKERS,
  testTimeout: TEST_TIMEOUT_MS,
};

export const definePackageConfig = () =>
  defineConfig({ resolve: { alias: packageAliases }, test: packageTest });
