// 这层管：全量测试发现、跨包解析（源码直连）与覆盖率门禁；不管测试内容。
// 各包的单包配置（pnpm -F <pkg> test）在 packages/*/vitest.config.ts，共用 vitest.shared.ts。
import { defineConfig } from "vitest/config";

import { packageAliases, packageTest } from "./vitest.shared.ts";

export default defineConfig({
  resolve: { alias: packageAliases },
  test: {
    ...packageTest,
    include: ["packages/*/tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // `pi-hreader.ts` 是单文件扩展（它在包根，不在 `src/` 下），必须显式列入覆盖率统计。
      include: ["packages/*/src/**/*.ts", "packages/*/pi-hreader.ts"],
      reporter: ["text", "json-summary"],
      // 任何一条用例失败时，默认的 `onTestFailure` 会先 `rm -rf` 掉 `coverage/.tmp`，而在途的
      // `writeFile(coverage-N.json)` 还在排着 —— 于是真正的失败被 `ENOENT coverage/.tmp/coverage-N.json`
      // 的 unhandled rejection 顶掉（§16.5）。保留临时目录，让失败以它本来的样子呈现。
      reportOnFailure: true,
      // 全局四维棘轮：2026-11-24 实测 lines/statements/functions/branches 全部 100，
      // 阈值取实测值防退化。不再用 perFile——它把"新建文件"变成必须先满测试的硬约束，
      // 全局阈值允许单文件低于阈值，只要总量不回退。
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
    },
  },
});
