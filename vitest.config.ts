// 这层管：测试发现、跨包解析（源码直连）与覆盖率门禁；不管测试内容。
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const fromRepoRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

// 包名 → 源码入口：测试与运行期都解析到同一份源码，避免 dist 产物与源码类身份不一致。
const ALIASES = [
  "@hreader/core",
  "@hreader/protocol",
  "@hreader/renderer-html",
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
    // CLI 用例的超时由 tests/harness.ts 自己管：每次 `runCli` 10s 硬超时（SIGKILL + 带命令行的错误），
    // `withTempDir` 10s 兜底。vitest 默认 5s 低于这两道守卫，并行有负载时总是它先触发，
    // 把可辨认的诊断盖成一句 "Test timed out in 5000ms"。30s = 约 3 次 CLI 调用的合法预算，
    // 让 harness 的守卫成为真正触发的那一道；显式写了更长时限的 Chrome/PDF 用例不受影响。
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      // `pi-hreader.ts` 是 M3.2 AC-1 强制的**单文件**扩展（它在包根，不在 `src/` 下），
      // 但"新文件也要过 perFile 四维 100%"是本卡风险点 6 的原话：不把它列进来，
      // 覆盖率就变成了对"零行文件"的 100%，是假绿。
      include: ["packages/*/src/**/*.ts", "packages/*/pi-hreader.ts"],
      reporter: ["text", "json-summary"],
      // 任何一条用例失败时，默认的 `onTestFailure` 会先 `rm -rf` 掉 `coverage/.tmp`，而在途的
      // `writeFile(coverage-N.json)` 还在排着 —— 于是真正的失败被 `ENOENT coverage/.tmp/coverage-N.json`
      // 的 unhandled rejection 顶掉（§16.5）。保留临时目录，让失败以它本来的样子呈现。
      reportOnFailure: true,
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
