// 这层管：渲染层共享的纯数据类型与纸张表；零 I/O、零第三方依赖。

export type PdfPageSize = "a4" | "letter" | "a5";

interface PaperSize {
  readonly widthPt: number;
  readonly heightPt: number;
}

/** 纸张表（pt）；Chrome 打印出来会舍入到 ±1.5pt，e2e 按这张表容差比。 */
export const PAGE_SIZES: Readonly<Record<PdfPageSize, PaperSize>> = {
  a4: { widthPt: 595.28, heightPt: 841.89 },
  letter: { widthPt: 612.0, heightPt: 792.0 },
  a5: { widthPt: 419.53, heightPt: 595.28 },
};

export const isPdfPageSize = (value: string): value is PdfPageSize =>
  value === "a4" || value === "letter" || value === "a5";

/** 长图请求：`width`/`maxHeight` 是 CSS 像素，`scale` 是设备像素倍率（超出 `maxHeight` 先裁不缩）。 */
export interface PngViewport {
  readonly width: number;
  readonly scale: number;
  readonly maxHeight: number;
}

export interface LongImage {
  readonly bytes: Uint8Array;
  /** 以下宽高都反读自 IHDR（设备像素）。 */
  readonly width: number;
  readonly height: number;
  readonly clipped: boolean;
}
