// 这层管：CLI 自己的字节 → 文本（严格 UTF-8、保留 BOM）与片段来源读取；不做 HTML/CSS/YAML 语义。

import { readFile, stat } from "node:fs/promises";

import { HrError } from "@hreader/core";

import type { HtmlSource } from "./args";

/** 与 core 的判定一致：BOM 是文档内容的一部分，不能被默认解码器静默吞掉。 */
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const codeOf = (error: unknown): unknown => Reflect.get(Object(error), "code");

export const decodeStrict = (bytes: Uint8Array, label: string): string => {
  try {
    return decoder.decode(bytes);
  } catch (error: unknown) {
    throw new HrError("invalid_utf8", `${label} 不是合法 UTF-8`, { cause: error });
  }
};

const readErrorOf = (error: unknown, path: string): HrError => {
  const missing = codeOf(error) === "ENOENT";
  return new HrError(
    missing ? "not_a_file" : "io_failure",
    missing ? `读取时路径不存在：${path}` : `读取失败：${path}`,
    { cause: error },
  );
};

const readFileOr = async (path: string): Promise<Uint8Array> => {
  try {
    return await readFile(path);
  } catch (error: unknown) {
    throw readErrorOf(error, path);
  }
};

export const readTextFile = async (path: string): Promise<string> =>
  decodeStrict(await readFileOr(path), path);

/**
 * 上限按字节算：`stat` 只读目录项，超限文件连一次解码器都不进（500 MiB 也不会被读成字符串）。
 * 尺寸是无符号整数，与 `readFile` 读到的 `byteLength` 同一个量。
 */
export const fileSizeOf = async (path: string): Promise<number> => {
  try {
    return (await stat(path)).size;
  } catch (error: unknown) {
    throw readErrorOf(error, path);
  }
};

export const sourceText = async (
  source: HtmlSource,
  readStdin: () => Promise<Uint8Array>,
): Promise<string> => {
  if (source.kind === "inline") return source.text;
  if (source.kind === "file") return readTextFile(source.path);
  return decodeStrict(await readStdin(), "<stdin>");
};
