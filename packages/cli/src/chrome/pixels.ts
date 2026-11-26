// This layer: hard gates on tall-image device pixels (pure functions, zero I/O). Beyond the single-edge
// or total-pixel caps Chrome's `Page.captureScreenshot` drops the connection outright (surfacing as
// `chrome_failed`), so out-of-range requests must become `invalid_input` before the screenshot and the
// user sees an actionable message instead of a Chrome crash. All lengths are **device pixels** (CSS size x scale), matching IHDR.

import { HrError } from "@hreader/core";

/** Per-edge pixel cap: 65535 is a conservative edge gate (real hardware can reach 76663; margin kept here); narrow/default widths hit the height gate first,
 * wide presets hit the area gate first. */
export const PIXEL_EDGE_LIMIT = 65_535;

/** Total-pixel cap: 2.5e8 is the VRAM/RAM safety line; wide enough requests hit it first (65535^2 is far above it). */
export const PIXEL_AREA_LIMIT = 250_000_000;

interface PixelFrame {
  /** Device-pixel width (`--width` x `--scale`). */
  readonly deviceWidth: number;
  /** Device-pixel height (clipped CSS height x `--scale`). */
  readonly deviceHeight: number;
}

interface PixelRequest {
  readonly width: number;
  readonly scale: number;
  readonly maxHeight: number;
  /** Whether the user explicitly passed `--max-height`: without it `maxHeight` is only a default and must not feed the worst-case area check. */
  readonly maxHeightExplicit: boolean;
}

const overflowOf = (frame: PixelFrame): string | undefined => {
  const size = `${String(frame.deviceWidth)}×${String(frame.deviceHeight)}`;
  if (frame.deviceWidth > PIXEL_EDGE_LIMIT || frame.deviceHeight > PIXEL_EDGE_LIMIT) {
    return `设备像素 ${size} 超过单边 ${String(PIXEL_EDGE_LIMIT)} 上限`;
  }
  if (frame.deviceWidth * frame.deviceHeight > PIXEL_AREA_LIMIT) {
    return `设备像素 ${size} 超过总像素 ${String(PIXEL_AREA_LIMIT)} 上限`;
  }
  return undefined;
};

const assertFrameOf = (frame: PixelFrame): void => {
  const reason = overflowOf(frame);
  // Both flags go in the hint: an edge overflow is usually a too-large `--max-height`, a total-pixel overflow a too-large `--scale`.
  if (reason !== undefined) {
    throw new HrError("invalid_input", `${reason}，请降 \`--scale\` 或 \`--max-height\``);
  }
};

/** Exact gate before the screenshot: `min(cssHeight, maxHeight)` is already a definite value here. */
export const assertPixelFrameOf = (frame: PixelFrame): void => {
  assertFrameOf(frame);
};

/**
 * Post-screenshot width gate: the multiply semantics of `clip.scale` and `deviceScaleFactor` changed across Chrome
 * versions — when only one is honored the image still renders but blurred to half resolution, and every downstream
 * size derived from it is wrong. A silently bad image is more dangerous than an error, so mismatches fail on the spot.
 * This is Chrome's internal inconsistency, not an out-of-range user request, hence `chrome_failed`, not `invalid_input`.
 */
export const assertShotWidthOf = (input: {
  readonly viewport: { readonly width: number; readonly scale: number };
  readonly deviceWidth: number;
}): void => {
  const expected = input.viewport.width * input.viewport.scale;
  if (input.deviceWidth !== expected) {
    throw new HrError(
      "chrome_failed",
      `长图实际宽 ${String(input.deviceWidth)}px，期望 ${String(input.viewport.width)}×${String(input.viewport.scale)}=${String(expected)}px（截图倍率语义变了？）`,
    );
  }
};

/** Post-screenshot height gate: same rule as width (`IHDR.height` should equal clipped height x `scale`), same class of Chrome internal inconsistency. */
export const assertShotHeightOf = (input: {
  readonly viewport: { readonly scale: number };
  readonly clipHeight: number;
  readonly deviceHeight: number;
}): void => {
  const expected = input.clipHeight * input.viewport.scale;
  if (input.deviceHeight !== expected) {
    throw new HrError(
      "chrome_failed",
      `长图实际高 ${String(input.deviceHeight)}px，期望 ${String(input.clipHeight)}×${String(input.viewport.scale)}=${String(expected)}px（截图倍率语义变了？）`,
    );
  }
};

/**
 * Preflight before Chrome starts. Width is independent of the real content height and is **always** checked.
 * The area gate runs only when the user explicitly passed `--max-height`: unset, it is just a default, and sizing
 * the worst case by it would wrongly refuse legal combos like `--width 4096 --scale 3` with a short document;
 * the real-area final check happens right before the screenshot (`assertPixelFrameOf`).
 */
export const assertPixelRequestOf = (request: PixelRequest): void => {
  const deviceWidth = request.width * request.scale;
  if (deviceWidth > PIXEL_EDGE_LIMIT) {
    throw new HrError(
      "invalid_input",
      `设备像素宽 ${String(deviceWidth)} 超过单边 ${String(PIXEL_EDGE_LIMIT)} 上限，请降 \`--width\` 或 \`--scale\``,
    );
  }
  if (!request.maxHeightExplicit) return;
  const worstArea = deviceWidth * request.maxHeight * request.scale;
  if (worstArea > PIXEL_AREA_LIMIT) {
    throw new HrError(
      "invalid_input",
      `--max-height ${String(request.maxHeight)} × --scale ${String(request.scale)} 最多会产生 ${String(worstArea)} 像素，超过总像素 ${String(PIXEL_AREA_LIMIT)} 上限，请降 \`--scale\` 或 \`--max-height\``,
    );
  }
};
