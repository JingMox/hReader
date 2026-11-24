// 这层管：`browser.ts` 适配层——`pageLikeOf`/`browserLikeOf` 把调用一一映射到 puppeteer
// 的方法面、报错统一折成 `chrome_failed`（ProtocolError 取 `originalMessage`），
// `browserOf` 负责握手失败时的文案。全程注入假对象，不起真 Chrome。
import { ProtocolError, type ConnectOptions } from "puppeteer-core";

import { HrError } from "@hreader/core";
import { describe, expect, it } from "vitest";

import { browserLikeOf, browserOf, pageLikeOf, type PdfPrintOptions } from "../src/chrome/browser";

const printOf = (outline: boolean): PdfPrintOptions => ({
  printBackground: true,
  preferCSSPageSize: false,
  width: "595.28pt",
  height: "841.89pt",
  margin: { top: "20mm", bottom: "20mm", left: "18mm", right: "18mm" },
  outline,
});

interface Calls {
  readonly goto: { url: string; options: unknown }[];
  readonly pdf: unknown[];
  readonly screenshot: unknown[];
  readonly setViewport: unknown[];
  sessions: number;
}

type Failures = Partial<Record<"goto" | "pdf" | "screenshot" | "setViewport" | "metrics", Error>>;

const stubOf = <T, R>(calls: T[], failure: Error | undefined, ok: R): ((arg: T) => Promise<R>) => {
  return (arg) => {
    calls.push(arg);
    return failure === undefined ? Promise.resolve(ok) : Promise.reject(failure);
  };
};

const puppeteerPageOf = (calls: Calls, failures: Failures = {}) => ({
  goto: (url: string, options: { waitUntil: "load"; timeout: number }) => {
    calls.goto.push({ url, options });
    return failures.goto === undefined ? Promise.resolve(null) : Promise.reject(failures.goto);
  },
  pdf: stubOf(calls.pdf, failures.pdf, new Uint8Array([0x25])),
  screenshot: stubOf(calls.screenshot, failures.screenshot, new Uint8Array([0x89])),
  setViewport: stubOf(calls.setViewport, failures.setViewport, undefined),
  createCDPSession: () => {
    calls.sessions += 1;
    return Promise.resolve({
      send: (method: string) =>
        failures.metrics === undefined
          ? Promise.resolve({ method, ok: true })
          : Promise.reject(failures.metrics),
    });
  },
});

const callsOf = (): Calls => ({ goto: [], pdf: [], screenshot: [], setViewport: [], sessions: 0 });

const failureOf = async (promise: Promise<unknown>): Promise<HrError> => {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof HrError) return error;
    throw error;
  }
  throw new Error("预期抛出 HrError");
};

const protocolErrorOf = (original: string): ProtocolError => {
  const error = new ProtocolError();
  error.originalMessage = original;
  return error;
};

describe("pageLikeOf · 方法映射", () => {
  it("goto 等 load、关掉 puppeteer 自带超时", async () => {
    const calls = callsOf();
    const page = pageLikeOf(puppeteerPageOf(calls));
    await page.goto("file:///x.html");
    expect(calls.goto).toEqual([
      { url: "file:///x.html", options: { waitUntil: "load", timeout: 0 } },
    ]);
  });

  it("pdf/screenshot/setViewport 的参数原样透传（screenshot 固定 type: png）", async () => {
    const calls = callsOf();
    const page = pageLikeOf(puppeteerPageOf(calls));
    const pdfOptions = printOf(true);
    await page.pdf(pdfOptions);
    expect(calls.pdf).toEqual([pdfOptions]);
    const shot = {
      clip: { x: 0, y: 0, width: 800, height: 600, scale: 1 },
      captureBeyondViewport: true,
    };
    await page.screenshot(shot);
    expect(calls.screenshot).toEqual([{ type: "png", ...shot }]);
    const viewport = { width: 800, height: 600, deviceScaleFactor: 2 };
    await page.setViewport(viewport);
    expect(calls.setViewport).toEqual([viewport]);
  });

  it("metrics 走一次性 CDP session，回包原文上交", async () => {
    const calls = callsOf();
    const page = pageLikeOf(puppeteerPageOf(calls));
    const first = await page.metrics();
    const second = await page.metrics();
    expect(calls.sessions).toBe(1);
    expect(first).toEqual({ method: "Page.getLayoutMetrics", ok: true });
    expect(second).toEqual({ method: "Page.getLayoutMetrics", ok: true });
  });
});

describe("pageLikeOf · 报错折叠", () => {
  it("普通错误取首行折成 chrome_failed", async () => {
    const calls = callsOf();
    const page = pageLikeOf(puppeteerPageOf(calls, { goto: new Error("navigate boom\nsecond") }));
    const error = await failureOf(page.goto("file:///x"));
    expect(error.code).toBe("chrome_failed");
    expect(error.message).toBe("Page.navigate 失败：navigate boom");
  });

  it("ProtocolError 用 originalMessage 去掉协议前缀", async () => {
    const calls = callsOf();
    const page = pageLikeOf(puppeteerPageOf(calls, { pdf: protocolErrorOf("Print job failed") }));
    const error = await failureOf(page.pdf(printOf(false)));
    expect(error.message).toBe("Page.printToPDF 失败：Print job failed");
  });
});

describe("pageLikeOf · 各方法的错误协议名", () => {
  it("setViewport 失败带协议名 Emulation.setDeviceMetricsOverride", async () => {
    const page = pageLikeOf(puppeteerPageOf(callsOf(), { setViewport: new Error("vp") }));
    const error = await failureOf(page.setViewport({ width: 1, height: 1, deviceScaleFactor: 1 }));
    expect(error.message).toBe("Emulation.setDeviceMetricsOverride 失败：vp");
  });

  it("screenshot / metrics 失败各自带协议名", async () => {
    const page = pageLikeOf(
      puppeteerPageOf(callsOf(), {
        screenshot: new Error("shot"),
        metrics: new Error("metrics"),
      }),
    );
    const shot = await failureOf(
      page.screenshot({
        clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 },
        captureBeyondViewport: true,
      }),
    );
    expect(shot.message).toBe("Page.captureScreenshot 失败：shot");
    expect((await failureOf(page.metrics())).message).toBe("Page.getLayoutMetrics 失败：metrics");
  });
});

describe("browserLikeOf", () => {
  it("newPage 成功后是 PageLike；失败折成 Target.createTarget 的 chrome_failed", async () => {
    const calls = callsOf();
    let disconnects = 0;
    const browser = browserLikeOf({
      newPage: () => Promise.resolve(puppeteerPageOf(calls)),
      disconnect: () => {
        disconnects += 1;
        return Promise.resolve();
      },
    });
    const page = await browser.newPage();
    await page.goto("file:///x");
    expect(calls.goto.length).toBe(1);
    browser.disconnect();
    expect(disconnects).toBe(1);

    const failing = browserLikeOf({
      newPage: () => Promise.reject(new Error("target gone\nstack")),
      disconnect: () => Promise.resolve(),
    });
    const error = await failureOf(failing.newPage());
    expect(error.code).toBe("chrome_failed");
    expect(error.message).toBe("Target.createTarget 失败：target gone");
  });
});

describe("browserOf", () => {
  it("握手参数固定：ws 端点 + protocolTimeout 0", async () => {
    const calls = callsOf();
    let seen: ConnectOptions | undefined;
    const browser = await browserOf("ws://127.0.0.1:9/devtools/browser/x", (options) => {
      seen = options;
      return Promise.resolve({
        newPage: () => Promise.resolve(puppeteerPageOf(calls)),
        disconnect: () => Promise.resolve(),
      });
    });
    expect(seen).toEqual({
      browserWSEndpoint: "ws://127.0.0.1:9/devtools/browser/x",
      protocolTimeout: 0,
    });
    expect(typeof browser.newPage).toBe("function");
  });

  it("握手失败折成 chrome_failed + 首行", async () => {
    const error = await failureOf(
      browserOf("ws://127.0.0.1:9/x", () =>
        Promise.reject(new Error("connect ECONNREFUSED\nmore")),
      ),
    );
    expect(error.code).toBe("chrome_failed");
    expect(error.message).toBe("连接 Chrome 失败：connect ECONNREFUSED");
  });
});
