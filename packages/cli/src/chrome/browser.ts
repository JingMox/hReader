// 这层管：puppeteer-core 的薄适配——把真 `Browser`/`Page` 折成渲染层要的最小面
// （`PageLike`/`BrowserLike`），并把 puppeteer 报错统一折成 `chrome_failed`。
// 报文序列、纸张/余白口径、长图算法在 `render.ts`；进程与端口在 `process.ts`/`session.ts`。

import { connect, ProtocolError, type ConnectOptions } from "puppeteer-core";

import { HrError } from "@hreader/core";

import { firstErrorLineOf, messageOf } from "../errors";

/** `page.pdf` 的入参：尺寸与余白一律带单位字符串——puppeteer 把裸数字当 px 而不是英寸。 */
export interface PdfPrintOptions {
  readonly printBackground: boolean;
  readonly preferCSSPageSize: boolean;
  readonly width: string;
  readonly height: string;
  readonly margin: {
    readonly top: string;
    readonly bottom: string;
    readonly left: string;
    readonly right: string;
  };
  readonly outline: boolean;
}

/** `clip.scale` 固定 1：倍率只由 viewport 的 `deviceScaleFactor` 给，两个都给会被 Chrome 乘两次。 */
export interface PngShotOptions {
  readonly clip: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly scale: number;
  };
  readonly captureBeyondViewport: boolean;
}

export interface ViewportSpec {
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
}

export interface PageLike {
  goto(url: string): Promise<void>;
  pdf(options: PdfPrintOptions): Promise<Uint8Array>;
  screenshot(options: PngShotOptions): Promise<Uint8Array>;
  setViewport(viewport: ViewportSpec): Promise<void>;
  /** `Page.getLayoutMetrics` 的原始回包：形状由调用方校验，这里不建模。 */
  metrics(): Promise<unknown>;
}

export interface BrowserLike {
  newPage(): Promise<PageLike>;
  /** fire-and-forget：清理路径不 await，进程回收由 `process.ts` 的进程组 kill 兜底。 */
  disconnect(): void;
}

/** puppeteer 对象在适配层暴露的最小面；真 `Page`/`Browser`/`CDPSession` 结构上都满足。 */
interface PuppeteerSession {
  send(method: "Page.getLayoutMetrics"): Promise<unknown>;
}

interface PuppeteerPage {
  goto(
    url: string,
    options: { readonly waitUntil: "load"; readonly timeout: number },
  ): Promise<unknown>;
  pdf(options: PdfPrintOptions): Promise<Uint8Array>;
  screenshot(options: PngShotOptions & { readonly type: "png" }): Promise<Uint8Array>;
  setViewport(viewport: ViewportSpec): Promise<void>;
  createCDPSession(): Promise<PuppeteerSession>;
}

interface PuppeteerBrowser {
  newPage(): Promise<PuppeteerPage>;
  disconnect(): Promise<void>;
}

/** CDP 层报错取 `originalMessage`（剥掉 puppeteer 加的 "Protocol error (...):" 前缀），其余取首行。 */
const reasonOf = (error: unknown): string =>
  error instanceof ProtocolError ? error.originalMessage : messageOf(error);

const failedOf = (method: string, error: unknown): HrError =>
  new HrError("chrome_failed", `${method} 失败：${firstErrorLineOf(reasonOf(error))}`, {
    cause: error,
  });

const callOf = async <T>(method: string, run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error: unknown) {
    throw failedOf(method, error);
  }
};

/** `timeout: 0` 关掉 puppeteer 自身的超时：期限统一由外层 `deadline` 管，报错才稳定是 `render_timeout`。 */
export const pageLikeOf = (page: PuppeteerPage): PageLike => {
  let session: Promise<PuppeteerSession> | undefined;
  return {
    goto: (url) =>
      callOf("Page.navigate", async () => {
        await page.goto(url, { waitUntil: "load", timeout: 0 });
      }),
    pdf: (options) => callOf("Page.printToPDF", () => page.pdf(options)),
    screenshot: (options) =>
      callOf("Page.captureScreenshot", () => page.screenshot({ type: "png", ...options })),
    setViewport: (viewport) =>
      callOf("Emulation.setDeviceMetricsOverride", () => page.setViewport(viewport)),
    metrics: () =>
      callOf("Page.getLayoutMetrics", async () => {
        session ??= page.createCDPSession();
        return await (await session).send("Page.getLayoutMetrics");
      }),
  };
};

export const browserLikeOf = (browser: PuppeteerBrowser): BrowserLike => ({
  newPage: () => callOf("Target.createTarget", async () => pageLikeOf(await browser.newPage())),
  disconnect: () => {
    void browser.disconnect();
  },
});

/**
 * 连到已抓到的 DevTools 浏览器端点。`protocolTimeout: 0` 同上：协议层不另设期限。
 * `connectFn` 是注入点：生产是 puppeteer 的 `connect`，测试给假实现，不起真 Chrome。
 */
export const browserOf = async (
  url: string,
  connectFn: (options: ConnectOptions) => Promise<PuppeteerBrowser> = connect,
): Promise<BrowserLike> => {
  try {
    return browserLikeOf(await connectFn({ browserWSEndpoint: url, protocolTimeout: 0 }));
  } catch (error: unknown) {
    throw new HrError("chrome_failed", `连接 Chrome 失败：${firstErrorLineOf(messageOf(error))}`, {
      cause: error,
    });
  }
};
