// This layer: page-level render sequences (open page -> navigate -> emit PDF / measure height -> clip tall image) and the page/margin/screenshot-pixel conventions;
// it knows neither transport nor process; `PageLike`/`BrowserLike` come from `browser.ts`'s puppeteer adapter.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { HrError } from "@hreader/core";

import type {
  BrowserLike,
  PageLike,
  PdfPrintOptions,
  PngShotOptions,
  RoutedRequest,
} from "./browser";
import { assertPixelFrameOf, assertShotHeightOf, assertShotWidthOf } from "./pixels";
import { pngSizeOf } from "./png";
import {
  PAGE_SIZES,
  type ExportRequestRecord,
  type ForeignPagePlan,
  type LongImage,
  type PdfPageSize,
  type PngViewport,
  type RenderSource,
} from "./types";

const MM = "mm";

/**
 * Page size and margins carry units for puppeteer to convert (bare numbers would read as px, not inches).
 * `generateDocumentOutline` is supplied explicitly by the caller (no default): forgetting it fails to compile rather than leaning on "default true".
 */
export const printParamsOf = (pageSize: PdfPageSize, outline: boolean): PdfPrintOptions => ({
  printBackground: true,
  // print-css.ts hardcodes `@page{size:A4}`: `true` would let CSS always win and `--page-size` would stop working.
  preferCSSPageSize: false,
  width: `${String(PAGE_SIZES[pageSize].widthPt)}pt`,
  height: `${String(PAGE_SIZES[pageSize].heightPt)}pt`,
  // With CSS page size off, the 0.4in default margins would override `@page{margin:20mm 18mm}`, so they must be given explicitly.
  margin: { top: `20${MM}`, bottom: `20${MM}`, left: `18${MM}`, right: `18${MM}` },
  // Headings are required for output: with `true` and no h1-h6 in the document, Chrome writes no `/Outlines` and reports no error.
  outline,
});

/**
 * Message for slides print sheets: the page box is delegated to the product's `@page` (13.333in x 7.5in, hardwired by the skeleton).
 * Width/height/margins are still fully populated per puppeteer's shape — the 16:9 fallback holds if the product `@page` is missing.
 */
export const cssPageParamsOf = (outline: boolean): PdfPrintOptions => ({
  printBackground: true,
  preferCSSPageSize: true,
  width: "960pt",
  height: "540pt",
  margin: { top: `0${MM}`, bottom: `0${MM}`, left: `0${MM}`, right: `0${MM}` },
  outline,
});

/** Every gated request, post-verdict — the record tests audit "the model held" against. Optional: managed sheets never gate. */
export type RequestAudit = (record: ExportRequestRecord) => void;

const gateRequestOf = async (
  request: RoutedRequest,
  plan: ForeignPagePlan,
  audit: RequestAudit | undefined,
): Promise<void> => {
  const answer = await plan.gate(request.url, request.method);
  audit?.({
    url: request.url,
    action: answer.kind,
    ...(answer.kind === "serve" ? { status: answer.reply.status } : {}),
  });
  if (answer.kind === "serve") await request.respond(answer.reply);
  else if (answer.kind === "allow") await request.continue();
  else await request.abort();
};

/**
 * D40: export is ONE navigation and one snapshot — a meta refresh needs no
 * JS and rides no CSP, so it can repaint the page mid-capture (a same-origin
 * /f/ path always serves, even with network off; under a granted network an
 * external page replaces the document). Veto every main-frame navigation
 * after the initial goto. The veto answers 204 rather than aborting: a
 * cancelled navigation commits Chrome's error page over the document, while
 * a no-content response drops the navigation and keeps the document —
 * nothing reaches the wire either way. Subframe and non-navigation requests
 * still take the normal gate verdict — the veto only knows the top frame.
 */
const exportHandlerOf = (
  plan: ForeignPagePlan,
  audit: RequestAudit | undefined,
): ((request: RoutedRequest) => Promise<void>) => {
  let initialNavDone = false;
  return async (request) => {
    if (request.navigation && request.mainFrame) {
      if (initialNavDone) {
        audit?.({ url: request.url, action: "deny" });
        await request.respond({ status: 204, headers: {}, body: "" });
        return;
      }
      initialNavDone = true;
    }
    await gateRequestOf(request, plan, audit);
  };
};

/** Shared opening for both render commands: newPage -> open the source (temp sheet file or gated capability URL) -> wait for load. */
const openPageOf = async (
  browser: BrowserLike,
  source: RenderSource,
  dir: string,
  audit: RequestAudit | undefined,
): Promise<PageLike> => {
  const page = await browser.newPage();
  if (source.kind === "foreign") {
    // Export is a one-shot snapshot of the rendered page: document scripts
    // NEVER run, even for a doc carrying a scripts grant — that grant exists
    // for the interactive reader, and a grant-free snapshot is the export
    // contract. The browser switch is the hard floor; CSP is defense-in-depth.
    await page.setJavaScriptEnabled(false);
    await page.routeRequests(exportHandlerOf(source.page, audit));
    await page.goto(source.page.url);
    return page;
  }
  const htmlPath = join(dir, "input.html");
  writeFileSync(htmlPath, source.html);
  // `pathToFileURL` rather than hand-built `file://`: spaces, non-ASCII names, or `#` in a hand-built path get parsed as host or fragment.
  await page.goto(pathToFileURL(htmlPath).href);
  return page;
};

interface PdfRenderInput {
  readonly browser: BrowserLike;
  readonly source: RenderSource;
  readonly dir: string;
  readonly pageSize: PdfPageSize;
  readonly outline: boolean;
  /** `true` = the product carries its own `@page` size (slides print sheet); Chrome obeys CSS rather than `pageSize`. */
  readonly preferCSSPageSize: boolean;
  readonly audit?: RequestAudit | undefined;
}

export const renderPdfOnBrowserOf = async (input: PdfRenderInput): Promise<Uint8Array> => {
  const page = await openPageOf(input.browser, input.source, input.dir, input.audit);
  const params = input.preferCSSPageSize
    ? cssPageParamsOf(input.outline)
    : printParamsOf(input.pageSize, input.outline);
  return page.pdf(params);
};

/** Temporary viewport height for measuring: a value far above the fold lets width settle first, then the full height is measured. */
const MEASURE_HEIGHT = 1000;

/** Re-measure viewport height for short documents: when `cssContentSize` is capped at one screen, a few-hundred-pixel document reads as viewport height, so measure again with a smaller viewport. */
const SHORT_MEASURE_HEIGHT = 100;

/** `cssContentSize` is the true full-page height: `layoutViewport` is only the visible screen and would clip tall images to the fold. */
const contentHeightOf = (metrics: unknown): number => {
  const size =
    typeof metrics === "object" && metrics !== null && "cssContentSize" in metrics
      ? metrics.cssContentSize
      : undefined;
  const height =
    typeof size === "object" && size !== null && "height" in size ? size.height : undefined;
  if (typeof height !== "number" || !Number.isFinite(height) || height < 1) {
    throw new HrError("render_empty", "Page.getLayoutMetrics 没有可用的页面高度");
  }
  return height;
};

const measureHeightOf = async (
  page: PageLike,
  viewport: PngViewport,
  height: number,
): Promise<number> => {
  await page.setViewport({ width: viewport.width, height, deviceScaleFactor: viewport.scale });
  return Math.ceil(contentHeightOf(await page.metrics()));
};

/**
 * Measure full-page height: settle width first with `MEASURE_HEIGHT`. When the document is shorter than one
 * screen, `cssContentSize` shrinks with the viewport to 1000, so a result no larger than `MEASURE_HEIGHT` is
 * re-measured at `SHORT_MEASURE_HEIGHT` to recover the real content height.
 */
const contentHeightAtOf = async (page: PageLike, viewport: PngViewport): Promise<number> => {
  const first = await measureHeightOf(page, viewport, MEASURE_HEIGHT);
  if (first > MEASURE_HEIGHT) return first;
  return measureHeightOf(page, viewport, SHORT_MEASURE_HEIGHT);
};

const shotParamsOf = (viewport: PngViewport, clipHeight: number): PngShotOptions => ({
  captureBeyondViewport: true,
  clip: { x: 0, y: 0, width: viewport.width, height: clipHeight, scale: 1 },
});

const capturePngOf = async (page: PageLike, viewport: PngViewport): Promise<LongImage> => {
  // Settle width before measuring height: otherwise `getLayoutMetrics` reads the previous viewport's layout and, with a very narrow `--width`,
  // the reported height comes out shorter than the real content.
  const cssHeight = await contentHeightAtOf(page, viewport);
  const clipHeight = Math.min(cssHeight, viewport.maxHeight);
  // The real content height is only known now: edge/total pixel gates run before the screenshot so overflow is `invalid_input`, not a Chrome crash.
  assertPixelFrameOf({
    deviceWidth: viewport.width * viewport.scale,
    deviceHeight: clipHeight * viewport.scale,
  });
  await page.setViewport({
    width: viewport.width,
    height: clipHeight,
    deviceScaleFactor: viewport.scale,
  });
  const bytes = await page.screenshot(shotParamsOf(viewport, clipHeight));
  // Width/height are always read back from IHDR: Chrome's return and the computed `width x scale` can both be off by a pixel, and the reported values must match the bytes on disk.
  const size = pngSizeOf(bytes);
  assertShotWidthOf({ viewport, deviceWidth: size.width });
  assertShotHeightOf({ viewport, clipHeight, deviceHeight: size.height });
  return {
    bytes,
    width: size.width,
    height: size.height,
    clipped: cssHeight > viewport.maxHeight,
  };
};

interface PngRenderInput extends PngViewport {
  readonly browser: BrowserLike;
  readonly source: RenderSource;
  readonly dir: string;
  readonly audit?: RequestAudit | undefined;
}

export const renderPngOnBrowserOf = async (input: PngRenderInput): Promise<LongImage> => {
  const page = await openPageOf(input.browser, input.source, input.dir, input.audit);
  return capturePngOf(page, input);
};
