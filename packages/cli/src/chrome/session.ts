// 这层管：单条渲染生命周期（起进程 → 渲染 vs 超时 vs 中断 → 收进程组与临时目录）与
// 生产用 `ChromeDeps` 的装配；页面级报文序列在 `render.ts`，进程监督在 `process.ts`。

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HrError } from "@hreader/core";

import { browserOf, type BrowserLike } from "./browser";
import { deadlineOf } from "./deadline";
import {
  chromeProcessOf,
  devtoolsUrlOf,
  startChromeOf,
  stopChromeOf,
  type ChromeDeps,
  type ChromeRun,
} from "./process";
import { renderPdfOnBrowserOf, renderPngOnBrowserOf } from "./render";
import type { LongImage, PdfPageSize } from "./types";

const KILL_GRACE_MS = 2000;

export const chromeDepsOf = (env: Readonly<Record<string, string | undefined>>): ChromeDeps => ({
  env,
  exists: existsSync,
  spawn: (file, args, options) => chromeProcessOf(spawn(file, [...args], options)),
  connect: browserOf,
  tempDir: () => mkdtempSync(join(tmpdir(), "hr-chrome-")),
  remove: (path) => {
    rmSync(path, { recursive: true, force: true });
  },
  killGraceMs: KILL_GRACE_MS,
});

/** 渲染命令共用的停止口：`run.ts` 传 `io.stop`，进程内测试传永挂的 promise。 */
interface ChromeRenderInput {
  readonly html: string;
  readonly timeoutMs: number;
  /** 必填：`main.ts` 已抑制信号默认行为，不交给渲染层就没人能中断（Ctrl-C 会白等满 `--timeout`）。 */
  readonly stop: Promise<void>;
  readonly deps: ChromeDeps;
}

interface RenderPdfInput extends ChromeRenderInput {
  readonly pageSize: PdfPageSize;
  readonly outline: boolean;
}

interface RenderPngInput extends ChromeRenderInput {
  readonly width: number;
  readonly scale: number;
  readonly maxHeight: number;
}

const connectBrowserOf = async (deps: ChromeDeps, run: ChromeRun): Promise<BrowserLike> => {
  const browser = await deps.connect(await devtoolsUrlOf(run));
  run.browser = browser;
  // 超时/中断已经在等 connect 的时候赢了：这时的连接不会再有人关，就地断开。
  if (run.stopped) browser.disconnect();
  return browser;
};

const sessionPdfOf = async (input: RenderPdfInput, run: ChromeRun): Promise<Uint8Array> =>
  renderPdfOnBrowserOf({
    browser: await connectBrowserOf(input.deps, run),
    html: input.html,
    dir: run.dir,
    pageSize: input.pageSize,
    outline: input.outline,
  });

const sessionPngOf = async (input: RenderPngInput, run: ChromeRun): Promise<LongImage> =>
  renderPngOnBrowserOf({
    browser: await connectBrowserOf(input.deps, run),
    html: input.html,
    dir: run.dir,
    width: input.width,
    scale: input.scale,
    maxHeight: input.maxHeight,
  });

/** `stop` 只 resolve：转成"到此为止"的拒绝，让 `Promise.race` 能放弃还在跑的渲染。 */
const interruptOf = (stop: Promise<void>): Promise<never> =>
  stop.then((): never => {
    throw new HrError("chrome_failed", "渲染被中断（收到 SIGINT/SIGTERM）");
  });

const overChromeOf = async <T>(
  input: ChromeRenderInput,
  render: (run: ChromeRun) => Promise<T>,
): Promise<T> => {
  const run = startChromeOf(input.deps);
  const deadline = deadlineOf(input.timeoutMs);
  try {
    const rendering = render(run);
    // 竞赛输掉之后这条链没人再接：挂个空处理器，别让它的失败变成 unhandled rejection。
    void rendering.catch(() => undefined);
    return await Promise.race([rendering, deadline.expired, interruptOf(input.stop)]);
  } finally {
    deadline.cancel();
    await stopChromeOf(run, input.deps);
  }
};

export const renderPdfOf = async (input: RenderPdfInput): Promise<{ bytes: Uint8Array }> => ({
  bytes: await overChromeOf(input, (run) => sessionPdfOf(input, run)),
});

export const renderPngOf = (input: RenderPngInput): Promise<LongImage> =>
  overChromeOf(input, (run) => sessionPngOf(input, run));
