// This layer: thin adapter over puppeteer-core — folds a real `Browser`/`Page` into the minimal surface
// (`PageLike`/`BrowserLike`) the render layer needs, and folds puppeteer errors into `chrome_failed`.
// Render sequences, page/margin semantics, and the tall-image algorithm live in `render.ts`; processes and endpoints in `process.ts`/`session.ts`.

import { connect, ProtocolError, type ConnectOptions } from "puppeteer-core";

import { HrError } from "@hreader/core";

import { firstErrorLineOf, messageOf } from "../errors";
import type { ExportLinkRewrite } from "./types";

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

/** One intercepted request, mid-flight: the handler must settle it exactly once via respond/continue/abort. */
export interface RoutedRequest {
  readonly url: string;
  readonly method: string;
  /** True for a frame navigation (document load, meta refresh, form submit, anchor activation) — a fetch is never one. */
  readonly navigation: boolean;
  /** True when the requesting frame is the page's main frame — export only ever snapshots that one. */
  readonly mainFrame: boolean;
  /** Answer from local bytes — no socket is touched (the /f/ serving verdicts run in-process). */
  respond(reply: {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string | Uint8Array;
  }): Promise<void>;
  /** Release to the network — the export gate only calls this for granted external requests. */
  continue(): Promise<void>;
  /** Fail closed: the request dies without an answer. */
  abort(): Promise<void>;
}

export interface PageLike {
  goto(url: string): Promise<void>;
  pdf(options: PdfPrintOptions): Promise<Uint8Array>;
  screenshot(options: PngShotOptions): Promise<Uint8Array>;
  setViewport(viewport: ViewportSpec): Promise<void>;
  /** Raw `Page.getLayoutMetrics` reply: the shape is validated by the caller, not modeled here. */
  metrics(): Promise<unknown>;
  /**
   * Browser-level script kill switch: export is a one-shot snapshot and
   * document scripts never run — this is harder than any CSP or markup
   * transform because nothing below it can smuggle execution back in.
   */
  setJavaScriptEnabled(enabled: boolean): Promise<void>;
  /**
   * The PDF /Title metadata falls back to the document URL when the page has
   * no `<title>` — for export that URL leaks the minted capability origin, so
   * the render layer fills in the file name instead. Inspector-side evaluate
   * still runs under `setJavaScriptEnabled(false)`: only page scripts die.
   */
  setTitleFallback(name: string): Promise<void>;
  /**
   * The link-annotation hygiene the PDF path runs before printToPDF:
   * same-origin anchors resolved onto the dead capability origin, and Chrome
   * stamps resolved hrefs into the artifact verbatim. Removing href
   * attributes in the already-loaded page can neither re-arm scripts nor
   * navigate — the same inspector-evaluate channel `setTitleFallback` uses.
   */
  rewriteExportLinks(rewrite: ExportLinkRewrite): Promise<void>;
  /** Arm request interception: every request the page issues runs `handler` exactly once and waits for its verdict. */
  routeRequests(handler: (request: RoutedRequest) => Promise<void>): Promise<void>;
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

/** Minimal shape of puppeteer's `HTTPRequest`; only the members interception needs. */
interface PuppeteerRequest {
  url(): string;
  method(): string;
  isNavigationRequest(): boolean;
  /** The frame the request was issued for — same object as `page.mainFrame()` for main-document navigations. */
  frame(): object | null;
  respond(response: {
    status: number;
    headers: Record<string, string>;
    body: string | Uint8Array;
  }): Promise<void>;
  continue(): Promise<void>;
  abort(): Promise<void>;
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
  setJavaScriptEnabled(enabled: boolean): Promise<void>;
  evaluate(pageFunction: string): Promise<unknown>;
  setRequestInterception(value: boolean): Promise<void>;
  /** The page's top-level frame — `request.frame()` identity-compares against it. */
  mainFrame(): object;
  on(event: "request", handler: (request: PuppeteerRequest) => void): void;
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

/**
 * The in-page half of `rewriteExportLinks`, kept as source text for the
 * inspector evaluate: `anchor.href` reads the resolved URL Chrome would stamp
 * into the PDF annotation, so a fragment to the document itself stays
 * internal and every other same-origin anchor loses its href (no
 * annotation) — Chrome only writes absolute URIs, so any path-bearing
 * rewrite would leak the exporting machine's layout.
 */
const REWRITE_LINKS_SOURCE = `(spec => {
  for (const anchor of document.querySelectorAll("a[href]")) {
    const url = new URL(anchor.href);
    if (url.origin !== spec.origin) continue;
    if (url.hash !== "" && url.pathname === spec.framePath) continue;
    anchor.removeAttribute("href");
  }
})`;

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
    setJavaScriptEnabled: (enabled) =>
      callOf("Emulation.setScriptExecutionDisabled", () => page.setJavaScriptEnabled(enabled)),
    setTitleFallback: (name) =>
      callOf("Runtime.evaluate", async () => {
        await page.evaluate(
          `(name => { if (document.title === "") document.title = name; })(${JSON.stringify(name)})`,
        );
      }),
    rewriteExportLinks: (rewrite) =>
      callOf("Runtime.evaluate", async () => {
        await page.evaluate(`(${REWRITE_LINKS_SOURCE})(${JSON.stringify(rewrite)})`);
      }),
    routeRequests: (handler) =>
      callOf("Network.setRequestInterception", async () => {
        await page.setRequestInterception(true);
        page.on("request", (request: PuppeteerRequest) => {
          void handler({
            url: request.url(),
            method: request.method(),
            navigation: request.isNavigationRequest(),
            mainFrame: request.frame() === page.mainFrame(),
            respond: (reply) =>
              request.respond({
                status: reply.status,
                headers: { ...reply.headers },
                body: reply.body,
              }),
            continue: () => request.continue(),
            abort: () => request.abort(),
          }).catch(() => {
            // A throwing gate must never leak a request into the wild — abort
            // is the fail-closed backstop; an already-handled race abort()s no-op.
            request.abort().catch(() => undefined);
          });
        });
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
