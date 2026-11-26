// This layer: thin adapter for `hr style extract` (read corpus -> stats layer -> write/print); no statistics, no style compilation.

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

/** 1 MiB per file, 4 MiB total. Check byte size before decoding — the CLI must not read over-limit corpus into a string for the user. */
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
    // Check the suffix before reading: a file with an illegal suffix need not be read in full to be refused.
    const format = formatOf(path);
    // Then check byte size (`stat`, no decode): an over-limit file must never be read into a string before being refused.
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
  /** Absolute paths of corpus files (argv order). */
  readonly files: readonly string[];
  readonly workspace: string;
  readonly id: string;
  readonly name: string;
  readonly inheritsVisual: string;
  /** `--out` as a workspace-relative path; `undefined` = print to stdout only. */
  readonly out: string | undefined;
  /** The `--out` printed in the receipt (user's view): falls back to the workspace-relative path when not given. */
  readonly displayOut?: string | undefined;
  readonly force: boolean;
  readonly json: boolean;
  /** Transport used when a key exists and `--no-llm` was not given; `undefined` = statistics-only run (a normal path, not an error). */
  readonly llm: LlmPort | undefined;
}

/**
 * `llm_failure` gets its CLI escape hatch here: core does not know `--no-llm` (a flag of this process).
 * What is banned is **automatic** retry (writes are not idempotent and spend real money) — not telling the user to retry by hand.
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
 * Preflight before spending: the overwrite guard, parent-dir guard, and out-of-bounds are all deterministic
 * failures that should not wait for the model to return (one call costs real money).
 * `out` is already normalized by `run.ts` to a workspace-relative path — a `..` prefix is out-of-bounds;
 * core's `saveStyleText` re-checks before writing.
 */
const assertOutWritable = async (input: StyleExtractInput): Promise<void> => {
  const out = input.out;
  if (out === undefined) return;
  if (out.startsWith("..")) {
    throw new HrError("path_outside_workspace", `风格只能写到 workspace 内：${out}`);
  }
  const target = resolve(input.workspace, out);
  // `--force` lifts exactly one thing — overwrite; the parent directory is still not auto-created.
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
