// 这层管：长图设备像素的硬闸（纯函数，零 I/O）。超过单边或总像素上限时 Chrome 的
// `Page.captureScreenshot` 会直接把连接打断（表现为 `chrome_failed`），所以越界请求要在
// 截图之前变成 `invalid_input`，让用户看到的是可操作的提示而不是 Chrome 崩溃。
// 长度单位一律是**设备像素**（CSS 尺寸 × scale），与 IHDR 的口径一致。

import { HrError } from "@hreader/core";

/** 单边像素上限：65535 是保守单边闸（真机 76663 也能出，此处留余量）；窄/默认宽度档先撞高边闸，
 * 宽档先撞面积闸。 */
export const PIXEL_EDGE_LIMIT = 65_535;

/** 总像素上限：2.5e8 是显存/内存的安全线，宽度够宽时先撞它（65535² 远大于此）。 */
export const PIXEL_AREA_LIMIT = 250_000_000;

interface PixelFrame {
  /** 设备像素宽（`--width × --scale`）。 */
  readonly deviceWidth: number;
  /** 设备像素高（裁剪后的 CSS 高 × `--scale`）。 */
  readonly deviceHeight: number;
}

interface PixelRequest {
  readonly width: number;
  readonly scale: number;
  readonly maxHeight: number;
  /** 用户是否显式传了 `--max-height`：没传时 `maxHeight` 只是默认值，不能拿它算最坏面积。 */
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
  // 两个 flag 都写在提示里：单边超限多半是 `--max-height` 太大，总像素超限多半是 `--scale` 太大。
  if (reason !== undefined) {
    throw new HrError("invalid_input", `${reason}，请降 \`--scale\` 或 \`--max-height\``);
  }
};

/** 截图前的精确闸：此时 `min(cssHeight, maxHeight)` 已经是确定值。 */
export const assertPixelFrameOf = (frame: PixelFrame): void => {
  assertFrameOf(frame);
};

/**
 * 截图后的宽度闸：`clip.scale` 与 `deviceScaleFactor` 的相乘语义在 Chrome 版本间变过——只认其中一个时
 * 图照样出得来，只是全糊成半分辨率，且下游据此算的尺寸全错。静默的坏图比报错危险，对不上就当场炸。
 * 这是 Chrome 内部不自洽，不是用户请求越界，所以报 `chrome_failed` 而不是 `invalid_input`。
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

/** 截图后的高度闸：与宽度同一口径（`IHDR.height` 应等于裁剪高 × `scale`），同属 Chrome 内部不自洽。 */
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
 * 起 Chrome 前的预检。宽度与真实内容高无关，**永远**查。
 * 面积闸只在用户显式给了 `--max-height` 时才查：没给时它只是默认值，按它算最坏面积会把
 * `--width 4096 --scale 3` 这种合法宽度 + 短文档的组合误拒；真实面积的终检在截图前（`assertPixelFrameOf`）。
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
