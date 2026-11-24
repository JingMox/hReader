// 这层管：页面级渲染序列（开页 → 导航 → 出 PDF / 量高 → 裁长图）与纸张/余白/截图像素口径；
// 传输与进程都不认识，`PageLike`/`BrowserLike` 由 `browser.ts` 适配 puppeteer 提供。

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { HrError } from "@hreader/core";

import type { BrowserLike, PageLike, PdfPrintOptions, PngShotOptions } from "./browser";
import { assertPixelFrameOf, assertShotHeightOf, assertShotWidthOf } from "./pixels";
import { pngSizeOf } from "./png";
import { PAGE_SIZES, type LongImage, type PdfPageSize, type PngViewport } from "./types";

const MM = "mm";

/**
 * 纸张与余白都带单位交给 puppeteer 换算（裸数字会被当成 px 而不是英寸）。
 * `generateDocumentOutline` 由调用方显式给（无默认值）：忘了传就编译不过，不靠"缺省 true"。
 */
export const printParamsOf = (pageSize: PdfPageSize, outline: boolean): PdfPrintOptions => ({
  printBackground: true,
  // print-css.ts 的 `@page{size:A4}` 是硬编码的：`true` 会让 CSS 永远赢，`--page-size` 直接失效。
  preferCSSPageSize: false,
  width: `${String(PAGE_SIZES[pageSize].widthPt)}pt`,
  height: `${String(PAGE_SIZES[pageSize].heightPt)}pt`,
  // 关掉 CSS 纸张后 0.4in 默认余白会压过 `@page{margin:20mm 18mm}`，必须显式给。
  margin: { top: `20${MM}`, bottom: `20${MM}`, left: `18${MM}`, right: `18${MM}` },
  // 有 heading 才产出：`true` 且文档没有 h1–h6 时，Chrome 不写 `/Outlines` 也不报错。
  outline,
});

/**
 * slides 打印稿的报文：页框交给产物里的 `@page`（13.333in × 7.5in 由骨架写死）。
 * 宽高/余白仍按 puppeteer 的形状给全——产物 `@page` 缺失时 16:9 兜底也成立。
 */
export const cssPageParamsOf = (outline: boolean): PdfPrintOptions => ({
  printBackground: true,
  preferCSSPageSize: true,
  width: "960pt",
  height: "540pt",
  margin: { top: `0${MM}`, bottom: `0${MM}`, left: `0${MM}`, right: `0${MM}` },
  outline,
});

/** 两条渲染命令共用的开场：newPage → 写临时 HTML → navigate 等 load。 */
const openPageOf = async (browser: BrowserLike, html: string, dir: string): Promise<PageLike> => {
  const page = await browser.newPage();
  const htmlPath = join(dir, "input.html");
  writeFileSync(htmlPath, html);
  // `pathToFileURL` 而不是手拼 `file://`：路径里有空格/中文/`#` 时手拼会被当成 host 或 fragment。
  await page.goto(pathToFileURL(htmlPath).href);
  return page;
};

interface PdfRenderInput {
  readonly browser: BrowserLike;
  readonly html: string;
  readonly dir: string;
  readonly pageSize: PdfPageSize;
  readonly outline: boolean;
  /** `true` = 产物自带 `@page` 纸张（slides 打印稿），Chrome 听 CSS 而不是 `pageSize`。 */
  readonly preferCSSPageSize: boolean;
}

export const renderPdfOnBrowserOf = async (input: PdfRenderInput): Promise<Uint8Array> => {
  const page = await openPageOf(input.browser, input.html, input.dir);
  const params = input.preferCSSPageSize
    ? cssPageParamsOf(input.outline)
    : printParamsOf(input.pageSize, input.outline);
  return page.pdf(params);
};

/** 量高用的临时视口高：给一个远大于首屏的值，先让宽度落定，再量整页高。 */
const MEASURE_HEIGHT = 1000;

/** 短文档的复量视口高：`cssContentSize` 只有一屏高时会把几百像素的文档量成视口高，换小视口再量一次。 */
const SHORT_MEASURE_HEIGHT = 100;

/** `cssContentSize` 才是整页高度：`layoutViewport` 只有视口那一屏，长图会截断在首屏。 */
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
 * 量整页高：先用 `MEASURE_HEIGHT` 落定宽度。文档比一屏矮时 `cssContentSize` 会跟着视口缩成 1000，
 * 所以结果不大于 `MEASURE_HEIGHT` 时再用 `SHORT_MEASURE_HEIGHT` 落一次视口复量，拿回真实内容高。
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
  // 先把宽度落定再量高：否则 `getLayoutMetrics` 读到的是上一轮视口的布局，`--width` 很窄时
  // 报出来的高度会比真实内容矮一截。
  const cssHeight = await contentHeightAtOf(page, viewport);
  const clipHeight = Math.min(cssHeight, viewport.maxHeight);
  // 真实内容高此时才知道：单边/总像素闸放在截图前，越界是 `invalid_input` 而不是 Chrome 崩。
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
  // 宽高一律反读 IHDR：Chrome 的返回值与自算的 `width × scale` 都可能偏差一像素，报告值必须与盘上字节一致。
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
  readonly html: string;
  readonly dir: string;
}

export const renderPngOnBrowserOf = async (input: PngRenderInput): Promise<LongImage> => {
  const page = await openPageOf(input.browser, input.html, input.dir);
  return capturePngOf(page, input);
};
