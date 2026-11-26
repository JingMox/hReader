// This layer: thin adapter over puppeteer-core — folds a real `Browser`/`Page` into the minimal surface
// (`PageLike`/`BrowserLike`) the render layer needs, and folds puppeteer errors into `chrome_failed`.
// Render sequences, page/margin semantics, and the tall-image algorithm live in `render.ts`; processes and endpoints in `process.ts`/`session.ts`.

import { connect, ProtocolError, type ConnectOptions } from "puppeteer-core";

import { HrError } from "@hreader/core";

import { firstErrorLineOf, messageOf } from "../errors";

/** `page.pdf` arguments: sizes and margins always carry unit strings — puppeteer treats bare numbers as px, not inches. */
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

/** `clip.scale` is pinned to 1: the factor comes only from the viewport's `deviceScaleFactor` — setting both makes Chrome multiply it twice. */
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
  /** Raw `Page.getLayoutMetrics` reply: the shape is validated by the caller, not modeled here. */
  metrics(): Promise<unknown>;
}

export interface BrowserLike {
  newPage(): Promise<PageLike>;
  /** Fire-and-forget: the cleanup path is not awaited; process-group kill in `process.ts` is the backstop. */
  disconnect(): void;
}

/** Minimal surface the adapter exposes for puppeteer objects; real `Page`/`Browser`/`CDPSession` all satisfy it structurally. */
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

/** CDP errors take `originalMessage` (stripping puppeteer's added "Protocol error (...):" prefix); everything else takes the first line. */
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

/** `timeout: 0` disables puppeteer's own timeout: the deadline is owned by the outer `deadline`, keeping failures a stable `render_timeout`. */
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
 * Connect to the captured DevTools browser endpoint. `protocolTimeout: 0` as above: the protocol layer gets no deadline of its own.
 * `connectFn` is the injection point: puppeteer's `connect` in production, a fake in tests so no real Chrome starts.
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
