// 这层管：`revision` 的算法（内容哈希前 16 位）；不做比较、不碰 IO。

import { sha256Hex } from "../io/digest";

/** 16 位十六进制 = 64 bit：本地单机去重足够，且能整段塞进 `Last-Event-ID` 与 URL。 */
export const REVISION_CHARS = 16;

export const revisionOf = (bytes: Uint8Array): string => sha256Hex(bytes).slice(0, REVISION_CHARS);
