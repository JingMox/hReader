// 这层管：变异测试的范围、跑法与防退化阈值；不管被测代码与单元测试本身。
// 报告与增量缓存都落在 .reports-tmp/（已 gitignore）；分批跑用 `pnpm test:mutation --mutate "<glob>"`。
/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
const config = {
  // 变异范围：安全关键与数据完整性关键的模块。app 的三个文件是补充范围。
  // 任务点名的安全/数据完整性关键模块（目录级 glob 会放大到 1.1 万个变异体，不可行）。
  mutate: [
    // html：sanitize（含 CSS 转义解码、hasExecutableContent）、serialize
    "packages/core/src/html/sanitize.ts",
    "packages/core/src/html/serialize.ts",
    // model：classify、load
    "packages/core/src/model/classify.ts",
    "packages/core/src/model/load.ts",
    // ops：patch-node、undo/history、import、normalize
    "packages/core/src/ops/patch-node/**/*.ts",
    "packages/core/src/ops/import.ts",
    "packages/core/src/ops/normalize-file.ts",
    "packages/core/src/ops/revert-op.ts",
    "packages/core/src/io/undo.ts",
    "packages/core/src/io/history.ts",
    // style：apply、css 安全检查、replaceTheme 相关
    "packages/core/src/style/apply.ts",
    "packages/core/src/style/apply-file.ts",
    "packages/core/src/style/css.ts",
    "packages/core/src/style/theme.ts",
    // io：paths、trust、lock、atomic write、digest
    "packages/core/src/io/paths.ts",
    "packages/core/src/io/trust.ts",
    "packages/core/src/io/lock.ts",
    "packages/core/src/io/atomic.ts",
    "packages/core/src/io/digest.ts",
    // server：auth、routes、handlers 写门、http-io body 解析、CSP 生成
    "packages/core/src/server/auth.ts",
    "packages/core/src/server/routes.ts",
    "packages/core/src/server/handlers.ts",
    "packages/core/src/server/http-io.ts",
    "packages/core/src/server/body.ts",
    "packages/core/src/server/static.ts",
    // cli：term() 与参数解析
    "packages/cli/src/output.ts",
    "packages/cli/src/args/**/*.ts",
    // app 小组件
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
  // 默认 sandbox 拷贝整个工作树；node_modules 走符号链接（symlinkNodeModules 默认 true，pnpm 布局下必须）。
  symlinkNodeModules: true,
  // sandbox 拷贝丢文件可执行位、且 pnpm 会把符号链接的 node_modules 判作外来而自动 install；
  // buildCommand 在每个 sandbox 里、初始测试运行前执行一次，细节见 scripts/stryker-prep.mjs。
  buildCommand: "node scripts/stryker-prep.mjs",
  incremental: true,
  incrementalFile: ".reports-tmp/stryker-incremental.json",
  reporters: ["clear-text", "progress", "html", "json"],
  htmlReporter: { fileName: ".reports-tmp/mutation/index.html" },
  jsonReporter: { fileName: ".reports-tmp/mutation/mutation.json" },
  // 本机 16GB 且并行跑其他负载：最多 2 个变异测试进程。
  concurrency: 3,
  // CLI 用例内部有 10s 硬超时，15s 给足预算又不让挂死变异体拖太久。
  timeoutMS: 15000,
  timeoutFactor: 1.5,
  thresholds: { high: 90, low: 75, break: 0 },
};

export default config;
