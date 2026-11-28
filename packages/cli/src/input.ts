// This layer: the CLI's own bytes -> text (strict UTF-8, BOM preserved) and fragment-source reads; no HTML/CSS/YAML semantics.

import { readFile, stat } from "node:fs/promises";
import type { Stats } from "node:fs";

import { HrError } from "@hreader/core";

import type { HtmlSource } from "./args";

/** Same rule as core: the BOM is part of the document content and must not be silently eaten by the default decoder. */
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

/** Raw document bytes (same `not_a_file`/`io_failure` mapping as `readTextFile`): content hashing wants the true bytes, not a UTF-8 round-trip. */
export const readFileBytes = readFileOr;

const notRegularFileOf = (path: string, stats: Stats): HrError => {
  const what = stats.isDirectory() ? "目录" : "非普通文件";
  return new HrError("invalid_input", `语料只能是普通文件：${path} 是${what}`);
};

/**
 * The cap is in bytes: `stat` only reads the directory entry, so an over-limit file never reaches the decoder
 * (a 500 MiB file is never read into a string). The size is an unsigned integer, the same quantity as the
 * `byteLength` `readFile` would report.
 *
 * Confirm it is a regular file first: directories, character devices (`/dev/zero` reports size 0), and FIFOs
 * (also size 0) would pass the cap check, after which `readFile` either reads unbounded or waits forever on a writer.
 *
 * `stat` follows symlinks: a link to a regular file counts as a regular file (same semantics as the `--out`
 * guard); only a resolved path that is still not a regular file is refused.
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

/** For `--out` preflight: not existing is the common case and "fail at write time" covers it anyway — this only answers early and cheaply. */
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
