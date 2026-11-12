// 这层管：把任意字符串映射成数值摘要/8 位十六进制 ID；不保证抗碰撞，只保证跨进程稳定。

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** 续算入口：`mixHex(片段, 上一段结果)` 把多段输入串成一条链（祖先路径摘要用）。 */
export const HASH_SEED = FNV_OFFSET_BASIS;

/**
 * FNV-1a 32 位，按 UTF-16 单元遍历、不按码点：代理对的两个单元都参与混合，
 * 否则 😀 / 😁 这类高位相同的字符会撞成同一个 ID。
 */
export const mixHex = (input: string, seed: number): number => {
  let hash = seed;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash;
};

/** 自包含实现（不碰 `node:crypto`）：ID 必须能在浏览器端复算。 */
export const stableHex8 = (input: string): string =>
  mixHex(input, FNV_OFFSET_BASIS).toString(16).padStart(8, "0");
