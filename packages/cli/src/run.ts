// 这层管：argv → 意图 → 命令 → 退出码（CLI 的 io 契约与错误归口）；不做解析、不做格式化。
// 用法错误是 CLI 自己的事：只走 stderr（卡片 §3 的 JSON 形状只描述 `HrError`），退出码 2；`--help` 一律 0。
// 进程相关的 io 在 `main.ts`：那里不可单测，逻辑全部留在本文件。

import { realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { HrError } from "@hreader/core";

import { parseArgs, type Intent } from "./args";
import { outlineCommand } from "./commands/outline";
import { patchCommand } from "./commands/patch";
import { readCommand } from "./commands/read";
import { styleCommand } from "./commands/style";
import { EXIT_INTERNAL, EXIT_OK, EXIT_USAGE, exitCodeOf } from "./exit-codes";
import { sourceText } from "./input";
import { jsonError } from "./output";
import { usageText, type CommandName } from "./usage";

export interface CliIo {
  readonly cwd: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly readStdin: () => Promise<Uint8Array>;
  readonly debug: boolean;
}

/** stdin 解码成功但为空：卡片 §7.4 定为用法错误（而不是 core 的 `invalid_fragment`）。 */
class UsageError extends Error {}

type Runnable = Exclude<Intent, { readonly kind: "help" }>;

const attemptRealpath = (path: string): string | undefined => {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
};

/** 目标可能尚不存在（patch 允许新建）：缺失后缀由最深的已存在祖先补全。 */
const realpathThroughAncestors = (path: string): string => {
  const real = attemptRealpath(path);
  if (real !== undefined) return real;
  const parent = dirname(path);
  return join(realpathThroughAncestors(parent), path.slice(parent.length + 1));
};

/** 写命令入参：workspace 与目标两侧都取真实路径再算相对路径（R1-P1-2）。
 * workspace 不存在时同走一条基准——`ENOENT` 由 core 报，不在这里被 realpath 吞掉。 */
const withinWorkspace = (input: {
  readonly workspace: string;
  readonly absolute: string;
}): { readonly workspace: string; readonly file: string } => {
  const workspace = attemptRealpath(input.workspace);
  if (workspace === undefined) throw new UsageError(`--workspace 不存在：${input.workspace}`);
  return { workspace, file: relative(workspace, realpathThroughAncestors(input.absolute)) };
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const runPatch = async (
  intent: Extract<Runnable, { kind: "patch" }>,
  io: CliIo,
): Promise<string> => {
  const html = intent.html === undefined ? undefined : await sourceText(intent.html, io.readStdin);
  if (intent.html?.kind === "stdin" && html === "") {
    throw new UsageError("--html-stdin 读到的内容为空");
  }
  const paths = withinWorkspace({ workspace: intent.workspace, absolute: intent.path });
  return patchCommand({
    path: paths.file,
    nodeId: intent.nodeId,
    action: intent.action,
    html,
    workspace: paths.workspace,
    json: intent.json,
  });
};

const runIntent = async (intent: Runnable, io: CliIo): Promise<string> => {
  if (intent.kind === "outline") return outlineCommand(intent);
  if (intent.kind === "read") return readCommand(intent);
  if (intent.kind === "style") {
    const paths = withinWorkspace({ workspace: intent.workspace, absolute: intent.path });
    return styleCommand({ ...intent, path: paths.file, workspace: paths.workspace });
  }
  return runPatch(intent, io);
};

const usageFailure = (message: string, topic: CommandName | undefined, io: CliIo): number => {
  io.stderr(`${message}\n${usageText(topic)}`);
  return EXIT_USAGE;
};

const reportFailure = (error: unknown, json: boolean, io: CliIo): number => {
  if (!(error instanceof HrError)) {
    io.stderr(`${messageOf(error)}\n`);
    if (io.debug && error instanceof Error && typeof error.stack === "string") {
      io.stderr(`${error.stack}\n`);
    }
    return EXIT_INTERNAL;
  }
  if (json) io.stdout(jsonError(error.code, error.message));
  io.stderr(`${error.message}\n`);
  return exitCodeOf(error.code);
};

export const run = async (argv: readonly string[], io: CliIo): Promise<number> => {
  const parsed = parseArgs(argv, io.cwd);
  if (!parsed.ok) return usageFailure(parsed.message, parsed.topic, io);
  if (parsed.intent.kind === "help") {
    io.stdout(usageText(parsed.intent.topic));
    return EXIT_OK;
  }
  const { json, kind } = parsed.intent;
  try {
    io.stdout(await runIntent(parsed.intent, io));
    return EXIT_OK;
  } catch (error: unknown) {
    if (error instanceof UsageError) return usageFailure(error.message, kind, io);
    return reportFailure(error, json, io);
  }
};
