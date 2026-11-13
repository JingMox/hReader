// 这层管：CLI 自己的字节 → 文本（严格 UTF-8、保留 BOM）与片段来源读取；不做 HTML/CSS/YAML 语义。

import { readFile } from "node:fs/promises";

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

const readFileOr = async (path: string): Promise<Uint8Array> => {
  try {
    return await readFile(path);
  } catch (error: unknown) {
    if (codeOf(error) === "ENOENT") {
      throw new HrError("not_a_file", `读取时路径不存在：${path}`, { cause: error });
    }
    throw new HrError("io_failure", `读取失败：${path}`, { cause: error });
  }
};

export const readTextFile = async (path: string): Promise<string> =>
  decodeStrict(await readFileOr(path), path);

export const sourceText = async (
  source: HtmlSource,
  readStdin: () => Promise<Uint8Array>,
): Promise<string> => {
  if (source.kind === "inline") return source.text;
  if (source.kind === "file") return readTextFile(source.path);
  return decodeStrict(await readStdin(), "<stdin>");
};
