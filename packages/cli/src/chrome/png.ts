// 这层管：PNG 字节的 IHDR 直读——产物 `width`/`height` 的唯一真源。
// Chrome 的截图返回值与命令层自算都可能陈旧（视口没落定前量到的高度就偏小），只有磁盘上那 24 字节可信。

import { HrError } from "@hreader/core";

interface PngSize {
  readonly width: number;
  readonly height: number;
}

/** PNG 签名 8 字节；后面紧跟 IHDR（长 13、类型 `IHDR`），宽高在 byte 16–23。 */
const PNG_MAGIC: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const IHDR_END = 24;

const hasPngMagicOf = (bytes: Uint8Array): boolean =>
  PNG_MAGIC.every((byte, index) => bytes[index] === byte);

export const assertPngOf = (bytes: Uint8Array): void => {
  if (bytes.length === 0) throw new HrError("render_empty", "Chrome 没有返回 PNG 字节");
  if (!hasPngMagicOf(bytes)) throw new HrError("render_empty", "Chrome 返回的产物不是 PNG");
  if (bytes.length < IHDR_END) throw new HrError("render_empty", "PNG 缺 IHDR，尺寸不可信");
};

export const pngSizeOf = (bytes: Uint8Array): PngSize => {
  assertPngOf(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
};
