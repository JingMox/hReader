// PNG fixture: minimal legal PNG bytes (IHDR width/height are big-endian at bytes 16–23), shared by fake-page screenshots and command-layer tests.
/** Minimal PNG: 8-byte signature + IHDR (w/h big-endian at bytes 16–23, bit depth 8 at byte 24) + a little tail. */
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
