// 这层管：argv → 意图 → 命令 → 退出码（CLI 的 io 契约与错误归口）；不做解析、不做格式化。
// 用法错误是 CLI 自己的码（`usage`），永不冒充 `HrErrorCode`；`--help` 一律 exit 0。
// 进程相关的 io 在 `main.ts`：那里不可单测，逻辑全部留在本文件。

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
  return patchCommand({
    path: intent.path,
    nodeId: intent.nodeId,
    action: intent.action,
    html,
    workspace: intent.workspace,
    json: intent.json,
  });
};

const runIntent = async (intent: Runnable, io: CliIo): Promise<string> => {
  if (intent.kind === "outline") return outlineCommand(intent);
  if (intent.kind === "read") return readCommand(intent);
  if (intent.kind === "style") return styleCommand(intent);
  return runPatch(intent, io);
};

const usageFailure = (
  message: string,
  topic: CommandName | undefined,
  json: boolean,
  io: CliIo,
): number => {
  if (json) io.stdout(jsonError("usage", message));
  io.stderr(`${message}\n${usageText(topic)}`);
  return EXIT_USAGE;
};

const reportFailure = (error: unknown, json: boolean, io: CliIo): number => {
  if (error instanceof UsageError) {
    io.stderr(`${error.message}\n`);
    return EXIT_USAGE;
  }
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
  if (!parsed.ok) return usageFailure(parsed.message, parsed.topic, parsed.json, io);
  if (parsed.intent.kind === "help") {
    io.stdout(usageText(parsed.intent.topic));
    return EXIT_OK;
  }
  const { json, kind } = parsed.intent;
  try {
    io.stdout(await runIntent(parsed.intent, io));
    return EXIT_OK;
  } catch (error: unknown) {
    if (error instanceof UsageError) return usageFailure(error.message, kind, json, io);
    return reportFailure(error, json, io);
  }
};
