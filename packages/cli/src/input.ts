// 这层管：CLI 自己的字节 → 文本（严格 UTF-8、保留 BOM）与片段来源读取；不做 HTML/CSS/YAML 语义。

import { readFile, stat } from "node:fs/promises";
import type { Stats } from "node:fs";

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

const notRegularFileOf = (path: string, stats: Stats): HrError => {
  const what = stats.isDirectory() ? "目录" : "非普通文件";
  return new HrError("invalid_input", `语料只能是普通文件：${path} 是${what}`);
};

/**
 * 上限按字节算：`stat` 只读目录项，超限文件连一次解码器都不进（500 MiB 也不会被读成字符串）。
 * 尺寸是无符号整数，与 `readFile` 读到的 `byteLength` 同一个量。
 *
 * 先确认是普通文件：目录、字符设备（`/dev/zero` 报 size 0）与 FIFO（同样 size 0）会让上限
 * 检查直接放行，随后 `readFile` 要么无界读、要么永远等不到写入方。
 *
 * `stat` 会跟随符号链接：指向普通文件的链接按普通文件处理（与 `--out` 的守卫同一语义），
 * 只有解析后仍不是普通文件才拒。
 */
export const fileSizeOf = async (path: string): Promise<number> => {
  let stats: Stats;
  try {
    stats = await stat(path);
  } catch (error: unknown) {
    throw readErrorOf(error, path);
  }
  if (!stats.isFile()) throw notRegularFileOf(path, stats);
  return stats.size;
};

/** `--out` 预检用：不存在是常态，「写盘时再报错」也能兜住——这里只为不花钱地提前判定。 */
export const existsOf = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
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
