// PNG 夹具：最小合法 PNG 字节 + 截图响应（`chrome-helpers.ts` 的 `Page.captureScreenshot` 用它回包）。
import type { FakeTransport } from "../src/chrome/transport";

/** 截图前必须有一次 `Emulation.setDeviceMetricsOverride`：这里记住它给的设备尺寸，截图照此回字节。 */
export interface Viewport {
  width: number;
  height: number;
  scale: number;
}

/** 截图区域（CSS 像素 × 倍率）；带 `clip` 时以 clip 为准，等价于真 Chrome 的裁剪口径。 */
export interface Capture {
  width: number;
  height: number;
  scale: number;
}

/** 最小 PNG：8 字节签名 + IHDR（w/h 大端在 byte 16–23，位深 8 在 byte 24）+ 一点尾巴。 */
export const pngOf = (width: number, height: number): Uint8Array => {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt8(8, 24);
  return Uint8Array.from(bytes);
};

export const pngBase64Of = (width: number, height: number): string =>
  Buffer.from(pngOf(width, height)).toString("base64");

export type PngMode =
  "ok" | "error" | "hang" | "no-data" | "not-png" | "half-width" | "half-height";

const jsonOf = (id: number, result: unknown): string => JSON.stringify({ id, result });

/** 半分辨率夹具：宽或高只给一半，用来验证截图后的倍率交叉断言。 */
const halfSizeOf = (
  mode: PngMode | undefined,
  capture: Capture,
): { readonly width: number; readonly height: number } | undefined => {
  if (mode === "half-width") {
    return {
      width: Math.round((capture.width * capture.scale) / 2),
      height: capture.height * capture.scale,
    };
  }
  if (mode === "half-height") {
    return {
      width: capture.width * capture.scale,
      height: Math.round((capture.height * capture.scale) / 2),
    };
  }
  return undefined;
};

export const screenshotOf = (
  mode: PngMode | undefined,
  base: FakeTransport,
  capture: Capture,
  id: number,
): void => {
  if (mode === "hang") return;
  if (mode === "error") {
    base.receive(JSON.stringify({ id, error: { message: "captureScreenshot boom\nat stack" } }));
    return;
  }
  if (mode === "no-data") {
    base.receive(jsonOf(id, {}));
    return;
  }
  if (mode === "not-png") {
    base.receive(jsonOf(id, { data: Buffer.from("GIF89a").toString("base64") }));
    return;
  }
  const half = halfSizeOf(mode, capture);
  if (half !== undefined) {
    base.receive(jsonOf(id, { data: pngBase64Of(half.width, half.height) }));
    return;
  }
  base.receive(
    jsonOf(id, {
      data: pngBase64Of(capture.width * capture.scale, capture.height * capture.scale),
    }),
  );
};
