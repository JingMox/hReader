// This layer owns: driving real Chrome. Underneath is puppeteer-core (the same
// dependency as the cli render layer, catalog-pinned): launch/newPage/CdpSession
// is the mainstream face, while assertions still all land on real page state.
// Externally it keeps the old hand-rolled CDP driver's minimal Page interface
// (eval/wait/key/click/navigate/reload), so suite code stays unchanged.

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
  /** Evaluate in the page (a Promise return is auto-awaited); a throw is a failure. */
  readonly eval: (expression: string) => Promise<unknown>;
  /** Poll a predicate in the page until truthy / timeout; returns the final value (the caller asserts). */
  readonly wait: (expression: string, timeoutMs?: number) => Promise<unknown>;
  readonly key: (key: string, code: string, windowsKeyCode: number) => Promise<void>;
  readonly click: (selector: string) => Promise<void>;
  /** Run this source first on every new document (before any page or iframe script): a race-free install channel. */
  readonly onNewDocument: (source: string) => Promise<void>;
  readonly navigate: (url: string) => Promise<void>;
  readonly reload: () => Promise<void>;
  /** Page errors, console.error entries and failed requests collected since page open. */
  readonly consoleErrors: () => readonly string[];
}

// The same flags as the old hand-rolled driver (headless itself goes through
// launch({ headless: true })); user-data-dir is puppeteer's self-managed temp
// profile, cleaned up on close().
const CHROME_ARGS: readonly string[] = [
  "--disable-gpu",
  "--no-sandbox",
  "--no-first-run",
  "--disable-extensions",
  "--remote-allow-origins=*",
];

const wrapPage = (inner: PuppeteerPage, session: CDPSession): Omit<Page, "consoleErrors"> => {
  // Go through CDPSession directly rather than page.evaluate: `userGesture:
  // true` gives the evaluation transient user activation — the presentation-mode
  // entry calls requestFullscreen() internally, and an el.click() without
  // activation is rejected on the spot (page.evaluate doesn't expose this
  // switch).
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
        `page evaluation failed: ${typeof description === "string" ? description : JSON.stringify(exception).slice(0, 300)}`,
      );
    }
    const value = result["result"];
    if (typeof value === "object" && value !== null) return Reflect.get(value, "value");
    return undefined;
  };

  return {
    sessionId: session.id(),
    eval: (expression) => evaluate(expression),
    // waitForFunction moves the predicate into in-page polling (60ms interval); a
    // predicate returning a Promise is awaited too. Navigation destroying the
    // execution context rejects the whole wait — same as the old implementation,
    // catch it and reopen a round within the deadline.
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
          // Execution context destroyed / transient disconnect: sleep a beat and retry until the deadline.
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
    // goto waits for domcontentloaded: the old Page.navigate was fire-and-forget
    // and callers then had to wait for state; returning only once a parseable DOM
    // exists adds semantics without removing any.
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
  assert(bin !== undefined, "no Chrome binary found");
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

/** Key constants: key name / code / Windows virtual key code (the Input.dispatchKeyEvent triple). */
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
