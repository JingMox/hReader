// 这层管：`hr style extract` 的薄适配（读语料 → 统计层 → 写盘/打印）；不做统计、不做样式编译。

import { dirname, extname, resolve } from "node:path";

import {
  HrError,
  extractStyle,
  extractStyleWithLlm,
  nodeStyleDeps,
  saveStyleText,
} from "@hreader/core";
import type {
  CorpusFormat,
  CorpusText,
  ExtractStyleLlmResult,
  ExtractStyleResult,
} from "@hreader/core";

import { existsOf, fileSizeOf, readTextFile } from "../input";
import type { LlmPort } from "../llm/client";
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
    // 再看字节数（`stat`，不解码）：超限文件绝不能先被读成字符串再拒。
    const bytes = await fileSizeOf(path);
    if (bytes > MAX_CORPUS_FILE_BYTES) {
      throw new HrError("invalid_input", `单篇语料超过 1 MiB：${path}（${String(bytes)} 字节）`);
    }
    total += bytes;
    if (total > MAX_CORPUS_BYTES) {
      throw new HrError("invalid_input", `语料总量超过 4 MiB（${String(total)} 字节）`);
    }
    corpus.push({ format, text: await readTextFile(path) });
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
  /** 回执里印的 `--out`（用户视角）：不给就印 workspace 相对路径。 */
  readonly displayOut?: string | undefined;
  readonly force: boolean;
  readonly json: boolean;
  /** 有 key 且没给 `--no-llm` 时的传输层；`undefined` = 纯统计版（D2 的降级，不是错误）。 */
  readonly llm: LlmPort | undefined;
}

/**
 * `llm_failure` 在这里补上 CLI 的出路：core 不认识 `--no-llm`（那是本进程的旗标）。
 * D7 禁的是**自动**重试（写盘非幂等 + 费用不可控），不是禁止提示用户手动重跑一次。
 */
const withNoLlmHint = (error: unknown): unknown =>
  error instanceof HrError && error.code === "llm_failure"
    ? new HrError(
        "llm_failure",
        `${error.message}，可加 --no-llm 只用统计结果；若是网络抖动，重跑一次即可`,
      )
    : error;

const llmResultOf = async (
  input: StyleExtractInput,
  corpus: readonly CorpusText[],
  llm: LlmPort,
): Promise<ExtractStyleLlmResult> => {
  try {
    return await extractStyleWithLlm({
      corpus,
      id: input.id,
      name: input.name,
      inheritsVisual: input.inheritsVisual,
      llm,
    });
  } catch (error: unknown) {
    throw withNoLlmHint(error);
  }
};

const emitOf = async (
  input: StyleExtractInput,
  result: ExtractStyleResult,
  dropped: readonly ExtractStyleLlmResult["dropped"][number][] | undefined,
): Promise<string> => {
  if (input.out === undefined) {
    return input.json ? jsonOk(dataStyleExtract(result, null, dropped)) : result.yaml;
  }
  await saveStyleText(
    { path: input.out, workspace: input.workspace, text: result.yaml, force: input.force },
    nodeStyleDeps(input.workspace),
  );
  return input.json
    ? jsonOk(dataStyleExtract(result, input.out, dropped))
    : humanStyleExtract(result, input.displayOut ?? input.out);
};

/**
 * 花钱前的预检：覆盖守卫、父目录守卫、越界都是确定性失败，不该等模型返回才报（一次调用是真金白银）。
 * `out` 已由 `run.ts` 归一到 workspace 相对路径，`..` 开头即越界；core 的 `saveStyleText` 写盘前会再查一遍。
 */
const assertOutWritable = async (input: StyleExtractInput): Promise<void> => {
  const out = input.out;
  if (out === undefined) return;
  if (out.startsWith("..")) {
    throw new HrError("path_outside_workspace", `风格只能写到 workspace 内：${out}`);
  }
  const target = resolve(input.workspace, out);
  // `--force` 只放开"覆盖"这一件事：父目录依旧不自动建（AC-6）。
  if (!input.force && (await existsOf(target))) {
    throw new HrError("file_exists", `目标已存在：${target}（加 --force 覆盖）`);
  }
  if (!(await existsOf(dirname(target)))) {
    throw new HrError("invalid_input", `父目录不存在：${dirname(target)}`);
  }
};

export const styleExtractCommand = async (input: StyleExtractInput): Promise<string> => {
  const corpus = await corpusOf(input.files);
  await assertOutWritable(input);
  const styleInput = {
    corpus,
    id: input.id,
    name: input.name,
    inheritsVisual: input.inheritsVisual,
  };
  if (input.llm === undefined) return emitOf(input, extractStyle(styleInput), undefined);
  const merged = await llmResultOf(input, corpus, input.llm);
  return emitOf(input, merged, merged.dropped);
};
