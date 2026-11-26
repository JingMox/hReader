// This layer: direct IHDR reads from PNG bytes — the single source of truth for product `width`/`height`.
// Both Chrome's screenshot return and the command layer's own math can be stale (a height measured before the viewport settled reads low); only the 24 bytes on disk are trustworthy.

import { HrError } from "@hreader/core";

interface PngSize {
  readonly width: number;
  readonly height: number;
}

/** The PNG signature is 8 bytes; IHDR follows (length 13, type `IHDR`), with width/height at bytes 16-23. */
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
