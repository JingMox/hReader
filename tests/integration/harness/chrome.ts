// 这层管：真 Chrome 的驱动。底层是 puppeteer-core（cli 渲染层同款依赖，catalog 统版）：
// launch/newPage/CdpSession 是主流面，断言仍全落在页面真实状态上。
// 对外保留原手写 CDP 的 Page 最小接口（eval/wait/key/click/navigate/reload），套件代码不变。

import {
  launch,
  TimeoutError,
  type Browser as PuppeteerBrowser,
  type CDPSession,
  type Page as PuppeteerPage,
} from "puppeteer-core";

import { killPid, registerChild } from "../../leak-guard/registry.ts";
import { assert } from "./check.ts";
import { chromePath } from "./env.ts";

export interface Browser {
  readonly open: (url: string) => Promise<Page>;
  readonly close: () => Promise<void>;
}

export interface Page {
  readonly sessionId: string;
  /** 页面内求值（返回值是 Promise 会自动 await）；抛错即失败。 */
  readonly eval: (expression: string) => Promise<unknown>;
  /** 页面内轮询谓词直到 truthy / 超时；返回最终值（调用方 assert）。 */
  readonly wait: (expression: string, timeoutMs?: number) => Promise<unknown>;
  readonly key: (key: string, code: string, windowsKeyCode: number) => Promise<void>;
  readonly click: (selector: string) => Promise<void>;
  /** 每次新文档创建时先跑这段脚本（早于页面与 iframe 的一切脚本）：免竞态的安装通道。 */
  readonly onNewDocument: (source: string) => Promise<void>;
  readonly navigate: (url: string) => Promise<void>;
  readonly reload: () => Promise<void>;
  /** Page errors, console.error entries and failed requests collected since page open. */
  readonly consoleErrors: () => readonly string[];
}

// 老 hand-rolled 驱动同款旗标（headless 本身走 launch({ headless: true }），
// user-data-dir 交给 puppeteer 自管临时 profile，close() 时一并清掉。
const CHROME_ARGS: readonly string[] = [
  "--disable-gpu",
  "--no-sandbox",
  "--no-first-run",
  "--disable-extensions",
  "--remote-allow-origins=*",
];

const wrapPage = (inner: PuppeteerPage, session: CDPSession): Omit<Page, "consoleErrors"> => {
  // 直走 CDPSession 而非 page.evaluate：需要 `userGesture: true` 让求值带上
  // transient user activation——演示模式入口内部会 requestFullscreen()，没激活态
  // 的 el.click() 会当场被拒（page.evaluate 没有暴露这个开关）。
  const evaluate = async (expression: string, awaitPromise = true): Promise<unknown> => {
    const result = (await session.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    })) as unknown as Readonly<Record<string, unknown>>;
    const exception = result["exceptionDetails"];
    if (typeof exception === "object" && exception !== null) {
      const detail: unknown = Reflect.get(exception, "exception");
      const description: unknown =
        typeof detail === "object" && detail !== null
          ? Reflect.get(detail, "description")
          : undefined;
      throw new Error(
        `页面求值异常：${typeof description === "string" ? description : JSON.stringify(exception).slice(0, 300)}`,
      );
    }
    const value = result["result"];
    if (typeof value === "object" && value !== null) return Reflect.get(value, "value");
    return undefined;
  };

  return {
    sessionId: session.id(),
    eval: (expression) => evaluate(expression),
    // waitForFunction 把谓词搬进页面轮询（polling 间隔 60ms），谓词返回 Promise 也会被 await；
    // 导航销毁执行上下文会让整次等待 reject——和旧实现一样，捕获后在 deadline 内重开一轮。
    wait: async (expression, timeoutMs = 20_000) => {
      const deadline = Date.now() + timeoutMs;
      const wrapped = `(() => { try { return (${expression}); } catch (error) { return false; } })()`;
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;
        try {
          const handle = await inner.waitForFunction(wrapped, {
            polling: 60,
            timeout: remaining,
          });
          const value: unknown = await handle.jsonValue();
          await handle.dispose();
          return value;
        } catch (error: unknown) {
          if (error instanceof TimeoutError) return false;
          // 执行上下文销毁/连接瞬断：睡一拍重试，直到 deadline。
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
      }
    },
    key: async (key, code, windowsKeyCode) => {
      const base = {
        key,
        code,
        windowsVirtualKeyCode: windowsKeyCode,
        nativeVirtualKeyCode: windowsKeyCode,
      };
      await session.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
      await session.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    },
    click: async (selector) => {
      await evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`,
        false,
      );
    },
    onNewDocument: async (source) => {
      await inner.evaluateOnNewDocument(source);
    },
    // goto 等 domcontentloaded：旧 Page.navigate 火后即忘，调用方随后都要 wait 状态；
    // 等到可解析 DOM 再回来，语义只增不减。
    navigate: async (next) => {
      await inner.goto(next, { waitUntil: "domcontentloaded", timeout: 30_000 });
    },
    reload: async () => {
      await inner.reload({ ignoreCache: true, waitUntil: "domcontentloaded", timeout: 30_000 });
    },
  };
};

export const launchBrowser = async (): Promise<Browser> => {
  const bin = chromePath();
  assert(bin !== undefined, "找不到 Chrome");
  const browser: PuppeteerBrowser = await launch({
    executablePath: bin,
    headless: true,
    args: [...CHROME_ARGS],
    timeout: 30_000,
  });
  // Puppeteer spawns Chrome detached: register it as a group leader so close()'s
  // fallback and the exit sweeper can take the whole group down.
  const chromeProc = browser.process();
  if (chromeProc !== null) {
    registerChild(chromeProc, { group: process.platform !== "win32", tag: "chrome" });
  }
  return {
    open: async (url) => {
      const inner = await browser.newPage();
      // Listeners attach before navigation so a broken module load (missing chunk,
      // unhandled pageerror, failed request) can never slip past the collector.
      const consoleErrors: string[] = [];
      inner.on("pageerror", (error: unknown) => {
        consoleErrors.push(`pageerror: ${String(error)}`);
      });
      inner.on("console", (message) => {
        if (message.type() === "error") {
          consoleErrors.push(
            `console.error: ${message.text()} (${message.location().url ?? "no url"})`,
          );
        }
      });
      inner.on("requestfailed", (request) => {
        consoleErrors.push(
          `requestfailed: ${request.url()} ${request.failure()?.errorText ?? "unknown"}`,
        );
      });
      inner.on("response", (response) => {
        if (response.status() >= 400) {
          consoleErrors.push(`http ${String(response.status())}: ${response.url()}`);
        }
      });
      const session = await inner.createCDPSession();
      const page: Page = {
        ...wrapPage(inner, session),
        consoleErrors: () => [...consoleErrors],
      };
      await page.navigate(url);
      return page;
    },
    close: async () => {
      const proc = browser.process();
      await browser.close().catch(() => undefined);
      // If close() hangs or fails, kill the whole group: Chrome must never be
      // handed over to the next suite.
      if (proc !== null && proc.exitCode === null && proc.signalCode === null) {
        killPid(proc.pid ?? -1, process.platform !== "win32");
      }
    },
  };
};

/** 键盘常量：键名 / code / Windows 虚拟键码（Input.dispatchKeyEvent 三件套）。 */
export const KEYS = {
  p: ["p", "KeyP", 80],
  w: ["w", "KeyW", 87],
  j: ["j", "KeyJ", 74],
  k: ["k", "KeyK", 75],
  c: ["c", "KeyC", 67],
  h: ["h", "KeyH", 72],
  Escape: ["Escape", "Escape", 27],
  ArrowRight: ["ArrowRight", "ArrowRight", 39],
  ArrowLeft: ["ArrowLeft", "ArrowLeft", 37],
  ArrowDown: ["ArrowDown", "ArrowDown", 40],
  ArrowUp: ["ArrowUp", "ArrowUp", 38],
  Home: ["Home", "Home", 36],
  End: ["End", "End", 35],
  PageDown: ["PageDown", "PageDown", 34],
  PageUp: ["PageUp", "PageUp", 33],
  F5: ["F5", "F5", 116],
  space: [" ", "Space", 32],
} as const;

export const press = async (page: Page, key: keyof typeof KEYS): Promise<void> => {
  const [name, code, vk] = KEYS[key];
  await page.key(name, code, vk);
};
