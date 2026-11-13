// 这层管：字节 ↔ 文本的严格往返与读取失败翻译；不含业务规则、不碰路径校验。

import { HrError } from "../hr-error";
import { failureOf } from "./errors";
import type { FileSystem } from "./ports";

const encoder = new TextEncoder();

/** `ignoreBOM: true` 让 BOM 留在文本里：默认会吞掉它，往返就少 3 字节（AC4 要求逐字节一致）。 */
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export const encodeUtf8 = (text: string): Uint8Array => encoder.encode(text);

export const decodeUtf8 = (bytes: Uint8Array, path: string): string => {
  try {
    return decoder.decode(bytes);
  } catch (error: unknown) {
    throw new HrError("io_failure", `目标文件不是合法 UTF-8：${path}`, { cause: error });
  }
};

export const readBytes = async (fsApi: FileSystem, path: string): Promise<Uint8Array> => {
  try {
    return await fsApi.readFile(path);
  } catch (error: unknown) {
    throw failureOf("读取", path, error);
  }
};
