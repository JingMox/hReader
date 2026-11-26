// This layer: Chrome process supervision — candidate-path discovery, spawn, the DevTools line, early exit, process-group reclamation.
// Messaging and page semantics live in `render.ts`/`browser.ts`; render deadline and interruption in `session.ts`.

import type { ChildProcess, SpawnOptions } from "node:child_process";
import { join } from "node:path";

import { HrError } from "@hreader/core";

import type { BrowserLike } from "./browser";
import { firstErrorLineOf, messageOf } from "../errors";

const CHROME_CANDIDATES: readonly string[] = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

const DEVTOOLS_LINE = /DevTools listening on (ws:\/\/\S+)/u;

/** stderr floods keep only the first 64 KiB: the DevTools line is at the front, error first lines within 200 chars; the rest is dropped. */
const STDERR_LIMIT = 64 * 1024;

export const stderrBufferOf = (buffer: string, text: string): string =>
  buffer.length >= STDERR_LIMIT ? buffer : (buffer + text).slice(0, STDERR_LIMIT);

export interface ChromeProcess {
  readonly pid: number | undefined;
  onStderr(cb: (text: string) => void): () => void;
  onExit(cb: (code: number | null) => void): void;
  onError(cb: (error: Error) => void): void;
  killGroup(signal: "SIGTERM" | "SIGKILL"): void;
}

export const chromeProcessOf = (child: ChildProcess): ChromeProcess => ({
  pid: child.pid,
  onStderr: (cb) => {
    const stderr = child.stderr;
    if (stderr === null) return () => undefined;
    stderr.setEncoding("utf8");
    stderr.on("data", cb);
    return () => {
      stderr.off("data", cb);
    };
  },
  onExit: (cb) => {
    child.on("exit", cb);
  },
  onError: (cb) => {
    child.on("error", cb);
  },
  // `--headless=new` renderer children only live in the process group `detached` creates: killing just the main pid leaves orphans holding the profile.
  killGroup: (signal) => {
    const pid = child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch {
      // Exited process (ESRCH) is a normal path: the SIGKILL backstop often lands after it.
    }
  },
});

/** Process-side deps shared by render commands; `connect` is the puppeteer handshake, `spawn`/`tempDir`/`remove` are injectable in tests. */
export interface ChromeDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly exists: (path: string) => boolean;
  readonly spawn: (file: string, args: readonly string[], options: SpawnOptions) => ChromeProcess;
  readonly connect: (url: string) => Promise<BrowserLike>;
  readonly tempDir: () => string;
  readonly remove: (path: string) => void;
  /** SIGTERM -> SIGKILL grace period: fixed 2s in production, shortened in in-process tests to keep the suite fast. */
  readonly killGraceMs: number;
}

const chromeMissingOf = (why: string): HrError =>
  new HrError(
    "chrome_missing",
    `找不到 Chrome（${why}）；候选路径：${CHROME_CANDIDATES.join(" / ")}`,
  );

/** `HREADER_CHROME` is authoritative once given: a bad path must error, never silently fall back to a system Chrome. */
const chromeBinaryOf = (deps: ChromeDeps): string => {
  const override = deps.env["HREADER_CHROME"];
  if (override !== undefined) {
    if (deps.exists(override)) return override;
    throw chromeMissingOf(`HREADER_CHROME=${override} 不存在`);
  }
  const found = CHROME_CANDIDATES.find((path) => deps.exists(path));
  if (found !== undefined) return found;
  throw chromeMissingOf("未设置 HREADER_CHROME");
};

const chromeArgsOf = (dir: string): readonly string[] => [
  "--headless=new",
  "--disable-gpu",
  "--no-sandbox",
  `--user-data-dir=${join(dir, "profile")}`,
  "--remote-debugging-port=0",
  "about:blank",
];

export interface ChromeRun {
  readonly dir: string;
  readonly process: ChromeProcess;
  /** Resolves when the group's main process exits: once SIGTERM lands there is no need to wait the full 2s before escalating to SIGKILL. */
  readonly exited: Promise<void>;
  browser: BrowserLike | undefined;
  /** Timeout/interrupt already won: a browser attached after this point must disconnect at once, or the socket pins the event loop. */
  stopped: boolean;
}

export const startChromeOf = (deps: ChromeDeps): ChromeRun => {
  const binary = chromeBinaryOf(deps);
  const dir = deps.tempDir();
  try {
    const child = deps.spawn(binary, chromeArgsOf(dir), {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const exited = new Promise<void>((resolve) => {
      child.onExit(() => {
        resolve();
      });
    });
    return { dir, process: child, exited, browser: undefined, stopped: false };
  } catch (error: unknown) {
    deps.remove(dir);
    throw new HrError("chrome_failed", `启动 Chrome 失败：${firstErrorLineOf(messageOf(error))}`, {
      cause: error,
    });
  }
};

const sleepOf = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Kills the process group: `--headless=new` renderer children do not hang off the main pid, so killing only that pid leaves orphans holding the profile. */
export const stopChromeOf = async (run: ChromeRun, deps: ChromeDeps): Promise<void> => {
  run.stopped = true;
  run.browser?.disconnect();
  run.process.killGroup("SIGTERM");
  await Promise.race([run.exited, sleepOf(deps.killGraceMs)]);
  run.process.killGroup("SIGKILL");
  deps.remove(run.dir);
};

/** The DevTools line carries the browser-level ws endpoint: `browserWSEndpoint` connects directly; `/json/version` is no longer needed. */
export const devtoolsUrlOf = (run: ChromeRun): Promise<string> =>
  new Promise((resolve, reject) => {
    let buffer = "";
    const detach = run.process.onStderr((text) => {
      buffer = stderrBufferOf(buffer, text);
      const url = DEVTOOLS_LINE.exec(buffer)?.[1];
      if (url !== undefined) {
        detach();
        resolve(url);
      }
    });
    // Remove it on success/failure too: a listener left on the flood is the other half of the memory defect.
    run.process.onExit((code) => {
      detach();
      const detail = firstErrorLineOf(buffer);
      reject(new HrError("chrome_failed", `Chrome 提前退出（code ${String(code)}）：${detail}`));
    });
    run.process.onError((error) => {
      detach();
      reject(new HrError("chrome_failed", `Chrome 启动失败：${firstErrorLineOf(error.message)}`));
    });
  });
