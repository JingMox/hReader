// PNG 夹具：最小合法 PNG 字节（IHDR 的宽高在 byte 16–23，大端），假页面截图与命令层测试共用。
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
