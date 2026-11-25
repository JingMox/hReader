// 这层管：真 Chrome 的 CDP 驱动（--headless=new + --remote-debugging-port=0 + 内置 WebSocket）。
// 不引 puppeteer：CDP 直连，断言全部落在页面真实状态上；页面内轮询谓词（awaitPromise）代替 sleep。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, parseJson } from "./check.ts";
import { chromePath } from "./env.ts";
import { live, type LiveProc } from "./proc.ts";

type CdpParams = Readonly<Record<string, unknown>>;

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export interface Browser {
  readonly open: (url: string) => Promise<Page>;
  readonly close: () => Promise<void>;
}

export interface Page {
  readonly sessionId: string;
  /** 同步 JS 求值；抛错即失败返回 Error。 */
  readonly eval: (expression: string) => Promise<unknown>;
  /** 页面内轮询谓词直到 truthy / 超时；返回最终值（调用方 assert）。 */
  readonly wait: (expression: string, timeoutMs?: number) => Promise<unknown>;
  readonly key: (key: string, code: string, windowsKeyCode: number) => Promise<void>;
  readonly click: (selector: string) => Promise<void>;
  readonly navigate: (url: string) => Promise<void>;
  readonly reload: () => Promise<void>;
}

interface WsLike {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: "message" | "open" | "error" | "close",
    listener: (event: unknown) => void,
  ): void;
}

/** Node 22+ 内置 WebSocket 的最小面（lib.dom 没编进来，走 globalThis 兜底）。 */
const WsCtor = (globalThis as { readonly WebSocket?: unknown }).WebSocket as new (
  url: string,
) => WsLike;

const connectWs = (url: string): Promise<WsLike> =>
  new Promise((resolve, reject) => {
    const ws = new WsCtor(url);
    const timer = setTimeout(() => {
      reject(new Error("CDP WebSocket 连接超时"));
    }, 10_000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("CDP WebSocket 连接失败"));
    });
  });

const CHROME_FLAGS = (profile: string): string[] => [
  "--headless=new",
  "--disable-gpu",
  "--no-sandbox",
  "--no-first-run",
  "--disable-extensions",
  "--remote-debugging-port=0",
  "--remote-allow-origins=*",
  `--user-data-dir=${profile}`,
];

/** stderr 里的一行 `DevTools listening on ws://…`：Chrome 唯一报端口的地方。 */
const waitWsLine = async (proc: LiveProc): Promise<string> => {
  // Chrome 把 ws 地址打 stderr；nextLine 只吃 stdout，所以这里改从 err() 文本轮询。
  const deadline = Date.now() + 15_000;
  for (;;) {
    const found = /DevTools listening on (ws:\/\/\S+)/u.exec(proc.out.err());
    if (found?.[1] !== undefined) return found[1];
    if (Date.now() > deadline) {
      throw new Error(`Chrome 没报 DevTools 地址（stderr：${proc.out.err().slice(0, 300)}）`);
    }
    if (!proc.alive()) throw new Error("Chrome 启动即退");
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
};

export const launchBrowser = async (): Promise<Browser> => {
  const bin = chromePath();
  assert(bin !== undefined, "找不到 Chrome");
  const profile = mkdtempSync(join(tmpdir(), "hr-it-chrome-"));
  const proc = live(bin, CHROME_FLAGS(profile));
  const wsUrl = await waitWsLine(proc);
  const ws = await connectWs(wsUrl);

  let seq = 0;
  const pending = new Map<number, PendingCall>();
  ws.addEventListener("message", (event: unknown) => {
    const data = (event as { data?: unknown }).data;
    if (typeof data !== "string") return;
    const parsed = parseJson(data, "CDP 帧");
    if (typeof parsed !== "object" || parsed === null) return;
    const id: unknown = Reflect.get(parsed, "id");
    if (typeof id !== "number") return;
    const call = pending.get(id);
    if (call === undefined) return;
    pending.delete(id);
    clearTimeout(call.timer);
    const error: unknown = Reflect.get(parsed, "error");
    if (typeof error === "object" && error !== null) {
      call.reject(new Error(`CDP ${JSON.stringify(error)}`));
      return;
    }
    call.resolve(Reflect.get(parsed, "result"));
  });
  ws.addEventListener("close", () => {
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error("CDP 连接已断"));
    }
    pending.clear();
  });

  const send = (
    method: string,
    params: CdpParams = {},
    sessionId?: string,
    timeoutMs = 30_000,
  ): Promise<unknown> => {
    seq += 1;
    const id = seq;
    return new Promise((resolve, reject) => {
      pending.set(id, {
        resolve,
        reject,
        timer: setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP 调用超时：${method}`));
        }, timeoutMs),
      });
      const frame: Record<string, unknown> = { id, method, params };
      if (sessionId !== undefined) frame["sessionId"] = sessionId;
      ws.send(JSON.stringify(frame));
    });
  };

  const evaluate = async (
    sessionId: string,
    expression: string,
    awaitPromise = false,
    timeoutMs = 30_000,
  ): Promise<unknown> => {
    const result = (await send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise, userGesture: true },
      sessionId,
      timeoutMs,
    )) as Readonly<Record<string, unknown>>;
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

  const openPage = async (url: string): Promise<Page> => {
    const created = (await send("Target.createTarget", { url: "about:blank" })) as Readonly<
      Record<string, unknown>
    >;
    const targetId = created["targetId"];
    assert(typeof targetId === "string", "Target.createTarget 没回 targetId");
    const attached = (await send("Target.attachToTarget", {
      targetId,
      flatten: true,
    })) as Readonly<Record<string, unknown>>;
    const sessionId = attached["sessionId"];
    assert(typeof sessionId === "string", "attach 没回 sessionId");
    await send("Page.enable", {}, sessionId);
    await send("Runtime.enable", {}, sessionId);

    const page: Page = {
      sessionId,
      eval: (expression) => evaluate(sessionId, expression, false),
      // 客户端轮询而不是单个长驻 evaluate：页面导航/重连会销毁执行上下文，
      // 长驻那个 evaluate 永远不resolve（CDP 30s 超时才轮到）——短调用 + 失败即重试更扛导航。
      wait: async (expression, timeoutMs = 20_000) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          let value: unknown = false;
          try {
            value = await evaluate(
              sessionId,
              `(() => { try { return (${expression}); } catch (error) { return false; } })()`,
              true,
              10_000,
            );
          } catch {
            value = false;
          }
          if (value) return value;
          if (Date.now() > deadline) return false;
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
      },
      key: async (key, code, windowsKeyCode) => {
        const base: CdpParams = {
          key,
          code,
          windowsVirtualKeyCode: windowsKeyCode,
          nativeVirtualKeyCode: windowsKeyCode,
        };
        await send("Input.dispatchKeyEvent", { type: "keyDown", ...base }, sessionId);
        await send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, sessionId);
      },
      click: async (selector) => {
        await evaluate(
          sessionId,
          `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`,
          false,
        );
      },
      navigate: async (next) => {
        await send("Page.navigate", { url: next }, sessionId);
      },
      reload: async () => {
        await send("Page.reload", { ignoreCache: true }, sessionId);
      },
    };
    await page.navigate(url);
    return page;
  };

  return {
    open: openPage,
    close: async () => {
      ws.close();
      proc.kill("SIGKILL");
      // 等进程真死再删 profile：SIGKILL 后立刻 rmSync 会撞 ENOTEMPTY（Chrome 还在写）。
      await Promise.race([proc.exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      rmSync(profile, { recursive: true, force: true });
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
