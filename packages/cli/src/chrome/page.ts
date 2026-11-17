// 这层管：页面会话的形状与长图量高（落视口 → 取整页高，短文档换小视口复量）；不碰进程与传输。

import { HrError } from "@hreader/core";

import { fieldOf, type CdpParams } from "./protocol";

interface CdpConnection {
  call(method: string, params: CdpParams, sessionId?: string): Promise<CdpParams>;
}

export interface PageSession {
  readonly connection: CdpConnection;
  readonly sessionId: string;
}

/** 量高只关心排版宽度与倍率；`maxHeight` 与量高无关，故不放进这个结构。 */
interface MeasureViewport {
  readonly width: number;
  readonly scale: number;
}

/** 量高用的临时视口高：给一个远大于首屏的值，先让宽度落定，再量整页高。 */
const MEASURE_HEIGHT = 1000;

/** 短文档的复量视口高：`cssContentSize` 只有一屏高时会把几百像素的文档量成视口高，换小视口再量一次。 */
const SHORT_MEASURE_HEIGHT = 100;

export const overrideViewportOf = async (
  page: PageSession,
  viewport: MeasureViewport,
  height: number,
): Promise<void> => {
  await page.connection.call(
    "Emulation.setDeviceMetricsOverride",
    {
      width: viewport.width,
      height,
      deviceScaleFactor: viewport.scale,
      mobile: false,
    },
    page.sessionId,
  );
};

/** `cssContentSize` 才是整页高度：`layoutViewport` 只有视口那一屏，长图会截断在首屏。 */
const contentHeightOf = (metrics: CdpParams): number => {
  const height = fieldOf(fieldOf(metrics, "cssContentSize"), "height");
  if (typeof height !== "number" || !Number.isFinite(height) || height < 1) {
    throw new HrError("render_empty", "Page.getLayoutMetrics 没有可用的页面高度");
  }
  return height;
};

const measureHeightOf = async (page: PageSession): Promise<number> => {
  const metrics = await page.connection.call("Page.getLayoutMetrics", {}, page.sessionId);
  return Math.ceil(contentHeightOf(metrics));
};

/**
 * 量整页高：先用 `MEASURE_HEIGHT` 落定宽度。文档比一屏矮时 `cssContentSize` 会跟着视口缩成 1000，
 * 所以结果不大于 `MEASURE_HEIGHT` 时再用 `SHORT_MEASURE_HEIGHT` 落一次视口复量，拿回真实内容高。
 */
export const contentHeightAtOf = async (
  page: PageSession,
  viewport: MeasureViewport,
): Promise<number> => {
  await overrideViewportOf(page, viewport, MEASURE_HEIGHT);
  const first = await measureHeightOf(page);
  if (first > MEASURE_HEIGHT) return first;
  await overrideViewportOf(page, viewport, SHORT_MEASURE_HEIGHT);
  return measureHeightOf(page);
};
