// 这层管：目录键与内容摘要（sha1 给 history/锁当键，sha256 给 undo 自证）；不碰 fs。

import { createHash, randomBytes } from "node:crypto";

// Stryker disable next-line StringLiteral: "utf8" 换成 "" 是等价变异——update 的编码参数为 falsy 时回落 utf8，digest 不变。
export const sha1Hex = (text: string): string =>
  createHash("sha1").update(text, "utf8").digest("hex");

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** tmp 与非重复用的随机后缀；同毫秒同进程也不会撞名。 */
export const nonce = (): string => randomBytes(6).toString("hex");
