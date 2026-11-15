// 这层管：测试发现、跨包解析（源码直连）与覆盖率门禁；不管测试内容。
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const fromRepoRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

// 包名 → 源码入口：测试与运行期都解析到同一份源码，避免 dist 产物与源码类身份不一致。
const ALIASES = [
  "@hreader/core",
  "@hreader/protocol",
  "@hreader/renderer-html",
  "@hreader/chrome-extension",
  "@hreader/app",
  "@hreader/mcp-server",
] as const;

export default defineConfig({
  resolve: {
    alias: Object.fromEntries(
      ALIASES.map((name) => [
        name,
        fromRepoRoot(`./packages/${name.slice("@hreader/".length)}/src/index.ts`),
      ]),
    ),
  },
  test: {
    include: ["packages/*/tests/**/*.test.ts"],
    // 本机 16GB / v8 覆盖率下，默认线程池（≈核数）会把 swap 打爆；2 个 worker 峰值内存约为原来的 1/3。
    // 这是限流，不是放宽门禁：阈值仍是 perFile 四维 100%。
    maxWorkers: 2,
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        perFile: true,
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
    },
  },
});
