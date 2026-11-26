// 这层管：跨包集成测试（tests/integration/**）的独立 Vitest 配置——
// 真 dist 产物 + 真 Chrome 的旅程级验证；不进 `pnpm test`（单测）与覆盖率门禁，CI 单跑。
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    // 每个套件都起自己的 daemon/Chrome/临时工作区：串行跑让端口与 tmpdir 的
    // 回收时序可预期（旧 run.ts 的"按套件串行子进程"在 Vitest 里的等价物）。
    fileParallelism: false,
    maxWorkers: 1,
    // 套件内最慢的用例是 desktop --smoke（90s 进程预算）；单测级 5s 默认会误杀。
    testTimeout: 120_000,
    // beforeAll 里要起 Chrome + daemon + MCP，比用例本身更贵。
    hookTimeout: 120_000,
    // 构建产物存在性检查 + 上次中断残留的 hr-it-* 沙箱清扫。
    globalSetup: ["tests/integration/global-setup.ts"],
  },
});
