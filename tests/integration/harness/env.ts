// 这层管：跨包集成测试共享的环境事实（仓内产物路径、临时工作区、轮询等待）；不碰业务逻辑。

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** 仓根：`tests/integration/harness/env.ts` 往上三层。 */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export const CLI_BIN = join(REPO_ROOT, "packages/cli/dist/cli.mjs");
export const MCP_BIN = join(REPO_ROOT, "packages/mcp-server/dist/main.js");
export const APP_DIR = join(REPO_ROOT, "packages/app/dist");
export const DESKTOP_DEBUG_BIN = join(
  REPO_ROOT,
  "packages/desktop/src-tauri/target/debug/hreader-desktop",
);

export const CHROME_CANDIDATES: readonly (string | undefined)[] = [
  process.env["CHROME_BIN"],
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

export const chromePath = (): string | undefined =>
  CHROME_CANDIDATES.find((path) => path !== undefined && existsSync(path));

export const chromeSkipReason = (): string | undefined => {
  if (process.env["HREADER_SKIP_CHROME"] === "1") return "HREADER_SKIP_CHROME=1";
  return chromePath() === undefined ? "找不到 Chrome/Edge/Chromium" : undefined;
};

export interface TestHome {
  /** 一次性沙箱根：`ws` 是文档工作区，`home` 给 `hr serve --home`（daemon.json 隔离）。 */
  readonly root: string;
  readonly ws: string;
  readonly home: string;
  readonly cleanup: () => void;
}

const live: string[] = [];

/** 每个用例各拿各的沙箱：测试之间（以及和并行 agent）靠路径隔离，不靠端口协调。 */
export const sandbox = (name: string): TestHome => {
  const root = mkdtempSync(join(tmpdir(), `hr-it-${name}-`));
  const ws = join(root, "ws");
  const home = join(root, "home");
  live.push(root);
  mkdirSync(ws, { recursive: true });
  mkdirSync(home, { recursive: true });
  return {
    root,
    ws,
    home,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
};

export const cleanupSandboxes = (): void => {
  for (const dir of live.splice(0)) rmSync(dir, { recursive: true, force: true });
};

export const sha256File = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * 轮询真条件而不是定时器：事件类断言（SSE 刷新、watcher、daemon 收尾）一律 `until`，
 * 断言才不和"等多久"耦合。返回最后一次采到的值。
 */
export const until = async <T>(
  sample: () => Promise<T> | T,
  done: (value: T) => boolean,
  options: { readonly timeoutMs?: number; readonly stepMs?: number } = {},
): Promise<T> => {
  const timeout = options.timeoutMs ?? 15_000;
  const step = options.stepMs ?? 50;
  const deadline = Date.now() + timeout;
  let value = await sample();
  while (!done(value)) {
    if (Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, step));
    value = await sample();
  }
  return value;
};
