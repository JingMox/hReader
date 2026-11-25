// 这层管：集成测试的 globalSetup——跑之前先证明 dist 产物在（旅程测的是打包产物，
// 不是 src），并清掉上一次中断残留的 hr-it-* 沙箱目录；不做任何业务断言。

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { APP_DIR, CLI_BIN, MCP_BIN } from "./harness/env.ts";

/** 套件真正用到的产物：CLI/MCP 的真二进制 + 阅读器静态面（daemon 的 --app-dir）。 */
const REQUIRED_ARTIFACTS: readonly { readonly path: string; readonly what: string }[] = [
  { path: CLI_BIN, what: "packages/cli 的 dist/cli.mjs" },
  { path: MCP_BIN, what: "packages/mcp-server 的 dist/main.js" },
  { path: join(APP_DIR, "index.html"), what: "packages/app 的 dist/index.html" },
  { path: join(APP_DIR, "assets", "main.js"), what: "packages/app 的 dist/assets/main.js" },
];

const SANDBOX_PREFIX = "hr-it-";
const started = Date.now();

export const setup = (): void => {
  const missing = REQUIRED_ARTIFACTS.filter(({ path }) => !existsSync(path));
  if (missing.length > 0) {
    throw new Error(
      `集成测试跑的是打包产物，以下 dist 不存在：${missing.map(({ what }) => what).join("、")}。先跑 pnpm build。`,
    );
  }
};

export const teardown = (): void => {
  // 只扫早于本次启动的 hr-it-*：并行 agent 的同前缀活目录不碰，
  // 本次运行自己建的沙箱由各套件 afterAll 的 cleanup 正常归还。
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith(SANDBOX_PREFIX)) continue;
    const dir = join(tmpdir(), name);
    try {
      if (statSync(dir).mtimeMs < started) rmSync(dir, { recursive: true, force: true });
    } catch {
      // 目录在扫描与删除之间被别的进程收走：不是失败。
    }
  }
};
