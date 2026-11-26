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

// 本机 16GB / v8 覆盖率下，默认线程池（≈核数）会把 swap 打爆；2 个 worker 峰值内存约为原来的 1/3。
// 这是限流，不是放宽门禁。CI runner 没有这层内存压力：GitHub Actions 置 `CI=true`，
// 此时放开 maxWorkers 让 vitest 用默认并行度（≈核数），换测试时长。
const LOCAL_MAX_WORKERS = 2;
// CLI 用例的超时由 tests/harness.ts 自己管：每次 runCli 10s 硬超时、withTempDir 10s 兜底。
// vitest 默认 5s 低于这两道守卫，并行有负载时总是它先触发，把可辨认的诊断盖成一句
// "Test timed out in 5000ms"。30s = 约 3 次 CLI 调用的合法预算。
const TEST_TIMEOUT_MS = 30_000;

export const packageTest = {
  include: ["tests/**/*.test.ts"],
  // 本机限 2 个 worker；CI（`CI` 环境变量存在）下不设键，走 vitest 默认并行度。
  ...(process.env["CI"] === undefined ? { maxWorkers: LOCAL_MAX_WORKERS } : {}),
  testTimeout: TEST_TIMEOUT_MS,
};

export const definePackageConfig = () =>
  defineConfig({ resolve: { alias: packageAliases }, test: packageTest });
