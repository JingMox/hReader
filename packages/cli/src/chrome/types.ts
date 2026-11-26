// This layer: pure data types and the page-size table shared by the render layer; zero I/O, zero third-party deps.

export type PdfPageSize = "a4" | "letter" | "a5";

interface PaperSize {
  readonly widthPt: number;
  readonly heightPt: number;
}

/** Page-size table (pt); Chrome's print output rounds to +/-1.5pt, and e2e compares with that tolerance. */
export const PAGE_SIZES: Readonly<Record<PdfPageSize, PaperSize>> = {
  a4: { widthPt: 595.28, heightPt: 841.89 },
  letter: { widthPt: 612.0, heightPt: 792.0 },
  a5: { widthPt: 419.53, heightPt: 595.28 },
};

export const isPdfPageSize = (value: string): value is PdfPageSize =>
  value === "a4" || value === "letter" || value === "a5";

/** Tall-image request: `width`/`maxHeight` are CSS pixels, `scale` the device-pixel factor (overflow past `maxHeight` is clipped, not scaled). */
export interface PngViewport {
  readonly width: number;
  readonly scale: number;
  readonly maxHeight: number;
}

export interface LongImage {
  readonly bytes: Uint8Array;
  /** The width/height below are read back from IHDR (device pixels). */
  readonly width: number;
  readonly height: number;
  readonly clipped: boolean;
}
