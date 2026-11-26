// Stryker `buildCommand`：在每个 sandbox 里、初始测试运行前执行一次。
// 两件事：
// 1) sandbox 拷贝把文件权限全写成 0644，把被 spawn / 断言 shebang 的交付物补回 +x；
// 2) node_modules 是符号链接，pnpm 10 判定为"外来"会触发 verify-deps-before-run 自动 install
//    （无 TTY 直接 abort）——往 sandbox 的 pnpm-workspace.yaml 追加开关关掉它。
// 只在 .stryker-tmp 沙箱里跑时改 workspace 配置；chmod 幂等，哪里跑都安全。

import { appendFileSync, chmodSync, readFileSync } from "node:fs";

const EXEC_FILES = [
  "packages/cli/fixtures/fake-chrome.mjs",
  "skills/hreader/scripts/hr.mjs",
  "packages/mcp-server/dist/main.js",
  "scripts/build-site.sh",
  "scripts/pack-skill.mjs",
  "packages/desktop/scripts/prepare-resources.mjs",
];

for (const file of EXEC_FILES) {
  try {
    chmodSync(file, 0o755);
  } catch {
    // 文件不在 sandbox 拷贝里就跳过
  }
}

const workspaceFile = "pnpm-workspace.yaml";
const workspace = readFileSync(workspaceFile, "utf8");
if (!workspace.includes("verifyDepsBeforeRun")) {
  appendFileSync(workspaceFile, "verifyDepsBeforeRun: false\n");
}
