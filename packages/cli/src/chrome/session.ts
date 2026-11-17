// 这层管：Chrome 进程 + 端口 + 超时（起进程、抓 DevTools 地址、探测 /json/version、进程组回收）；报文在 `cdp.ts`。

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HrError } from "@hreader/core";

import { renderPdfOverCdpOf, renderPngOverCdpOf, type LongImage, type PdfPageSize } from "./cdp";
import { deadlineOf } from "./deadline";
import { firstErrorLineOf } from "./protocol";
import { wsTransportOf, type ChromeTransport } from "./transport";

const CHROME_CANDIDATES: readonly string[] = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

const DEVTOOLS_LINE = /DevTools listening on (ws:\/\/\S+)/u;

const KILL_GRACE_MS = 2000;

/** stderr 洪流只留前 64 KiB（§15.3）：DevTools 行在开头，错误首行在前 200 字，超出直接丢。 */
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

export interface ChromeDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly exists: (path: string) => boolean;
  readonly spawn: (file: string, args: readonly string[], options: SpawnOptions) => ChromeProcess;
  readonly fetchText: (url: string) => Promise<string>;
  readonly connect: (url: string) => ChromeTransport;
  readonly tempDir: () => string;
  readonly remove: (path: string) => void;
  /** SIGTERM 到 SIGKILL 的间隔：生产固定 2s，进程内测试调小以免拖慢套件。 */
  readonly killGraceMs: number;
}

export const chromeDepsOf = (env: Readonly<Record<string, string | undefined>>): ChromeDeps => ({
  env,
  exists: existsSync,
  spawn: (file, args, options) => chromeProcessOf(spawn(file, [...args], options)),
  fetchText: async (url) => (await globalThis.fetch(url)).text(),
  connect: wsTransportOf,
  tempDir: () => mkdtempSync(join(tmpdir(), "hr-chrome-")),
  remove: (path) => {
    rmSync(path, { recursive: true, force: true });
  },
  killGraceMs: KILL_GRACE_MS,
});

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
}

interface RenderPngInput extends ChromeRenderInput {
  readonly width: number;
  readonly scale: number;
  readonly maxHeight: number;
}

interface ChromeRun {
  readonly dir: string;
  readonly process: ChromeProcess;
  /** 组内主进程退出即 resolve：SIGTERM 生效后就不必再等满 2s 才升级 SIGKILL。 */
  readonly exited: Promise<void>;
  transport: ChromeTransport | undefined;
  /** 超时/中断已经赢：此后才绑上的 transport 必须当场关，否则 socket 挂住事件循环。 */
  stopped: boolean;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const startChromeOf = (deps: ChromeDeps): ChromeRun => {
  const binary = chromeBinaryOf(deps);
  const dir = deps.tempDir();
  try {
    const process = deps.spawn(binary, chromeArgsOf(dir), {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const exited = new Promise<void>((resolve) => {
      process.onExit(() => {
        resolve();
      });
    });
    return { dir, process, exited, transport: undefined, stopped: false };
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
const stopChromeOf = async (run: ChromeRun, deps: ChromeDeps): Promise<void> => {
  run.stopped = true;
  run.transport?.close();
  run.process.killGroup("SIGTERM");
  await Promise.race([run.exited, sleepOf(deps.killGraceMs)]);
  run.process.killGroup("SIGKILL");
  deps.remove(run.dir);
};

const devtoolsUrlOf = (run: ChromeRun): Promise<string> =>
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
    // 结束/失败也要摘掉：监听器留在洪流上就是 P1 内存缺陷的另一半（§15.3）。
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

const versionUrlOf = (devtoolsUrl: string): string => {
  const url = new URL(devtoolsUrl);
  if (url.port === "") {
    throw new HrError("chrome_failed", `Chrome 的 DevTools 地址没有端口：${devtoolsUrl}`);
  }
  return `http://${url.hostname}:${url.port}/json/version`;
};

/** `/json/version` 只用来拿 `webSocketDebuggerUrl`：按名字取一个字符串字段，不必按完整 JSON 建模。 */
const WS_URL = /"webSocketDebuggerUrl"\s*:\s*"([^"]+)"/u;

const wsUrlOf = async (deps: ChromeDeps, devtoolsUrl: string): Promise<string> => {
  let text: string;
  try {
    text = await deps.fetchText(versionUrlOf(devtoolsUrl));
  } catch (error: unknown) {
    throw new HrError(
      "chrome_failed",
      `读取 /json/version 失败：${firstErrorLineOf(messageOf(error))}`,
      { cause: error },
    );
  }
  const url = WS_URL.exec(text)?.[1];
  if (url === undefined) {
    throw new HrError("chrome_failed", "Chrome 的 /json/version 没有 webSocketDebuggerUrl");
  }
  return url;
};

const transportOf = async (deps: ChromeDeps, run: ChromeRun): Promise<ChromeTransport> => {
  const devtoolsUrl = await devtoolsUrlOf(run);
  const transport = deps.connect(await wsUrlOf(deps, devtoolsUrl));
  run.transport = transport;
  // 超时/中断已经在等 transport 的时候赢了：这时的 socket 不会再有人关，就地关掉。
  if (run.stopped) transport.close();
  return transport;
};

const sessionPdfOf = async (input: RenderPdfInput, run: ChromeRun): Promise<Uint8Array> =>
  renderPdfOverCdpOf({
    transport: await transportOf(input.deps, run),
    html: input.html,
    dir: run.dir,
    pageSize: input.pageSize,
  });

const sessionPngOf = async (input: RenderPngInput, run: ChromeRun): Promise<LongImage> =>
  renderPngOverCdpOf({
    transport: await transportOf(input.deps, run),
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

/** 单条渲染生命周期：起进程 → 渲染 vs 超时 vs 中断 → 无论如何收进程组与临时目录。 */
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
