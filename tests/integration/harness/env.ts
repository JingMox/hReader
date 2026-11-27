// This layer owns: environment facts shared by the cross-package integration
// tests (in-repo artifact paths, temp workspaces, polling waits); no business
// logic.

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root: three levels up from `tests/integration/harness/env.ts`. */
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
  return chromePath() === undefined ? "no Chrome/Edge/Chromium found" : undefined;
};

export interface TestHome {
  /** One-shot sandbox root: `ws` is the document workspace, `home` goes to `hr serve --home` (daemon.json isolation). */
  readonly root: string;
  readonly ws: string;
  readonly home: string;
  readonly cleanup: () => void;
}

const live: string[] = [];

/** Each case gets its own sandbox: tests (and parallel agents) isolate by path, not by port coordination. */
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
 * Poll a real condition instead of a timer: event-based assertions (SSE
 * refresh, watcher, daemon teardown) all go through `until`, so assertions
 * stay decoupled from "how long to wait". Returns the last sampled value.
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
