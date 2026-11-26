// 这层管：Chrome 进程监督——候选路径发现、spawn、DevTools 行、提前退出、进程组回收。
// 报文与页面语义在 `render.ts`/`browser.ts`；渲染期限与中断在 `session.ts`。

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

/** stderr 洪流只留前 64 KiB：DevTools 行在开头，错误首行在前 200 字，超出直接丢。 */
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
  // `--headless=new` 的渲染子进程只挂在 `detached` 起的进程组里：杀主 pid 会留孤儿占住 profile。
  killGroup: (signal) => {
    const pid = child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch {
      // 进程已退出（ESRCH）是正常路径：SIGKILL 兜底经常落在它之后。
    }
  },
});

/** 渲染命令共用的进程侧依赖；`connect` 是 puppeteer 握手，`spawn`/`tempDir`/`remove` 在测试里可注入。 */
export interface ChromeDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly exists: (path: string) => boolean;
  readonly spawn: (file: string, args: readonly string[], options: SpawnOptions) => ChromeProcess;
  readonly connect: (url: string) => Promise<BrowserLike>;
  readonly tempDir: () => string;
  readonly remove: (path: string) => void;
  /** SIGTERM 到 SIGKILL 的间隔：生产固定 2s，进程内测试调小以免拖慢套件。 */
  readonly killGraceMs: number;
}

const chromeMissingOf = (why: string): HrError =>
  new HrError(
    "chrome_missing",
    `找不到 Chrome（${why}）；候选路径：${CHROME_CANDIDATES.join(" / ")}`,
  );

/** `HREADER_CHROME` 一旦给了就是权威：写错要报错，不能悄悄退回系统装的 Chrome。 */
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
  /** 组内主进程退出即 resolve：SIGTERM 生效后就不必再等满 2s 才升级 SIGKILL。 */
  readonly exited: Promise<void>;
  browser: BrowserLike | undefined;
  /** 超时/中断已经赢：此后才绑上的 browser 必须当场 disconnect，否则 socket 挂住事件循环。 */
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

/** 杀的是进程组：`--headless=new` 的渲染子进程不挂在主 pid 上，只杀主 pid 会留孤儿占住 profile。 */
export const stopChromeOf = async (run: ChromeRun, deps: ChromeDeps): Promise<void> => {
  run.stopped = true;
  run.browser?.disconnect();
  run.process.killGroup("SIGTERM");
  await Promise.race([run.exited, sleepOf(deps.killGraceMs)]);
  run.process.killGroup("SIGKILL");
  deps.remove(run.dir);
};

/** DevTools 行自带浏览器级 ws 端点：`browserWSEndpoint` 直连，不再需要 `/json/version`。 */
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
    // 结束/失败也要摘掉：监听器留在洪流上就是内存缺陷的另一半。
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
