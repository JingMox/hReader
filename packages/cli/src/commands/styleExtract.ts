// 这层管：`hr style extract` 的薄适配（读语料 → 统计层 → 写盘/打印）；不做统计、不做样式编译。

import { extname } from "node:path";

import { HrError, extractStyle, nodeStyleDeps, saveStyleText } from "@hreader/core";
import type { CorpusFormat, CorpusText, ExtractStyleResult } from "@hreader/core";

import { readTextFileSized } from "../input";
import { dataStyleExtract, humanStyleExtract, jsonOk } from "../output";

/** D9：单篇 1 MiB、总量 4 MiB。先看字节数再解码，别让 CLI 替用户把超限语料读成字符串。 */
export const MAX_CORPUS_FILE_BYTES = 1024 * 1024;

export const MAX_CORPUS_BYTES = 4 * 1024 * 1024;

const FORMATS: Readonly<Record<string, CorpusFormat>> = {
  ".htm": "html",
  ".html": "html",
  ".md": "markdown",
  ".markdown": "markdown",
};

const formatOf = (path: string): CorpusFormat => {
  const format = FORMATS[extname(path).toLowerCase()];
  if (format === undefined) {
    throw new HrError("invalid_input", `语料只接受 .md / .html：${path}`);
  }
  return format;
};

const corpusOf = async (files: readonly string[]): Promise<readonly CorpusText[]> => {
  const corpus: CorpusText[] = [];
  let total = 0;
  for (const path of files) {
    // 先看后缀再读盘：后缀不合法的文件没必要整份读进来再拒。
    const format = formatOf(path);
    const sized = await readTextFileSized(path);
    if (sized.bytes > MAX_CORPUS_FILE_BYTES) {
      throw new HrError(
        "invalid_input",
        `单篇语料超过 1 MiB：${path}（${String(sized.bytes)} 字节）`,
      );
    }
    total += sized.bytes;
    if (total > MAX_CORPUS_BYTES) {
      throw new HrError("invalid_input", `语料总量超过 4 MiB（${String(total)} 字节）`);
    }
    corpus.push({ format, text: sized.text });
  }
  return corpus;
};

export interface StyleExtractInput {
  /** 语料文件的绝对路径（argv 顺序）。 */
  readonly files: readonly string[];
  readonly workspace: string;
  readonly id: string;
  readonly name: string;
  readonly inheritsVisual: string;
  /** `--out` 的 workspace 相对路径；`undefined` = 只打印到 stdout。 */
  readonly out: string | undefined;
  readonly force: boolean;
  readonly json: boolean;
}

export const styleExtractCommand = async (input: StyleExtractInput): Promise<string> => {
  const result: ExtractStyleResult = extractStyle({
    corpus: await corpusOf(input.files),
    id: input.id,
    name: input.name,
    inheritsVisual: input.inheritsVisual,
  });
  if (input.out === undefined) {
    return input.json ? jsonOk(dataStyleExtract(result, null)) : result.yaml;
  }
  await saveStyleText(
    { path: input.out, workspace: input.workspace, text: result.yaml, force: input.force },
    nodeStyleDeps(input.workspace),
  );
  return input.json
    ? jsonOk(dataStyleExtract(result, input.out))
    : humanStyleExtract(result, input.out);
};
