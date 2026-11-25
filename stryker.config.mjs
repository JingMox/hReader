// 这层管：变异测试的范围、跑法与防退化阈值；不管被测代码与单元测试本身。
// 报告与增量缓存都落在 .reports-tmp/（已 gitignore）；分批跑用 `pnpm test:mutation --mutate "<glob>"`。
/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
const config = {
  // 变异范围：安全关键与数据完整性关键的模块。app 的三个文件是补充范围。
  mutate: [
    "packages/core/src/html/**/*.ts",
    "packages/core/src/model/**/*.ts",
    "packages/core/src/ops/**/*.ts",
    "packages/core/src/style/**/*.ts",
    "packages/core/src/io/**/*.ts",
    "packages/core/src/server/**/*.ts",
    "packages/cli/src/output.ts",
    "packages/cli/src/args/**/*.ts",
    "packages/app/src/widgets/present.ts",
    "packages/app/src/widgets/foreign.ts",
    "packages/app/src/escape-attr.ts",
  ],
  testRunner: "vitest",
  // pnpm 的 .pnpm 真实路径布局会让默认的 "@stryker-mutator/*" glob 扫不到 runner，必须显式声明。
  plugins: ["@stryker-mutator/vitest-runner"],
  // pool 对齐 vitest 默认（forks）：有测试用 process.chdir 验证 cwd 无关性，threads 池不支持。
  vitest: { configFile: "vitest.config.ts", pool: "forks" },
  // perTest：只为每个变异体跑覆盖到它的测试，否则全量套件跑一遍不可行。
  coverageAnalysis: "perTest",
  // vitest 的变异在内存里做，不需要全仓拷贝的 sandbox；拷贝还会丢 fixture 的 exec 位。
  inPlace: true,
  incremental: true,
  incrementalFile: ".reports-tmp/stryker-incremental.json",
  reporters: ["clear-text", "progress", "html", "json"],
  htmlReporter: { fileName: ".reports-tmp/mutation/index.html" },
  jsonReporter: { fileName: ".reports-tmp/mutation/mutation.json" },
  // 本机 16GB 且并行跑其他负载：最多 2 个变异测试进程。
  concurrency: 2,
  // CLI 用例内部有 10s 硬超时，15s 给足预算又不让挂死变异体拖太久。
  timeoutMS: 15000,
  timeoutFactor: 1.5,
  thresholds: { high: 90, low: 75, break: 0 },
};

export default config;
