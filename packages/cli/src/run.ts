// 这层管：argv → 意图 → 命令 → 退出码（CLI 的 io 契约与错误归口）；用法错误只走 stderr、退出码 2，`--help` 一律 0。
// 不做解析、不做格式化；进程相关的 io 在不可单测的 `main.ts`，逻辑全部留在本文件。

import { homedir } from "node:os";
import { join, relative } from "node:path";

import { HrError, nodeStyleDeps } from "@hreader/core";

import { parseArgs, type Intent } from "./args";
import { attemptRealpath, realpathThroughAncestors } from "./canonical";
import { chromeDepsOf, renderPdfOf, renderPngOf } from "./chrome/session";
import { checkCommand } from "./commands/check";
import { exportPrintCommand } from "./commands/export-print";
import { importDocCommand } from "./commands/import";
import { newDocCommand } from "./commands/new";
import { normalizeCommand } from "./commands/normalize";
import { outlineCommand } from "./commands/outline";
import { patchCommand } from "./commands/patch";
import { pdfCommand } from "./commands/pdf";
import { pngCommand } from "./commands/png";
import { readCommand } from "./commands/read";
import { styleCommand } from "./commands/style";
import { styleExtractCommand } from "./commands/style-extract";
import { undoCommand } from "./commands/undo";
import { HintedError, StrictFailure } from "./errors";
import { EXIT_FAILURE, EXIT_INTERNAL, EXIT_OK, EXIT_USAGE, exitCodeOf } from "./exit-codes";
import { sourceText } from "./input";
import { LLM_TIMEOUT_MS, createLlmClient, type LlmPort } from "./llm/client";
import { apiKeyOf, baseUrlOf, modelOf, normalizeBaseUrl, sessionIdOf } from "./llm/session";
import { displayedPathOf, jsonError, term } from "./output";
import { serveCommandOf } from "./run-serve";
import { isDiscoveredStylePath, undiscoveredHint } from "./style-out";
import { usageText, type CommandName } from "./usage";

export interface CliIo {
  readonly cwd: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly readStdin: () => Promise<Uint8Array>;
  readonly debug: boolean;
  /** env 快照：`process.env` 只在 `main.ts` 取一次（不传 = 无 key）；测试据此注入假 key。 */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** LLM 分支的网络注入点：不传 = 真 `fetch`；测试据此回放 `fixtures/llm/`。 */
  readonly fetch?: typeof globalThis.fetch;
  /** serve 靠它感知 SIGTERM/SIGINT；其它命令不需要（测试里构造 io 时可省）。 */
  readonly stop?: Promise<void>;
  /** 启动时父进程的 pid：**必填**，只有 `main.ts` 能在首个 `await` 之前采集它（`?? process.ppid` 兜底 = 又把"晚读"写回来）。 */
  readonly launchParentPid: number;
  readonly home?: string;
}

/** stdin 解码成功但为空：定为用法错误（而不是 core 的 `invalid_fragment`）。 */
class UsageError extends Error {}

type Runnable = Exclude<Intent, { readonly kind: "help" }>;
/** 写命令入参：两边都取真实路径再算相对；workspace 不存在时同走一条基准，`ENOENT` 交给 core。 */
const workspaceRealpathOf = (workspace: string): string => {
  const real = attemptRealpath(workspace);
  if (real === undefined) throw new UsageError(`--workspace 不存在：${workspace}`);
  return real;
};
/** `--home` 与 `--workspace` 同一口径：存在才收（`.hreader/` 由 core 建，home 本身不代建）。 */
const homeRealpathOf = (home: string): string => {
  const real = attemptRealpath(home);
  if (real === undefined) throw new UsageError(`--home 目录不存在：${home}`);
  return real;
};

const withinWorkspace = (input: {
  readonly workspace: string;
  readonly absolute: string;
}): { readonly workspace: string; readonly file: string } => ({
  workspace: workspaceRealpathOf(input.workspace),
  file: relative(workspaceRealpathOf(input.workspace), realpathThroughAncestors(input.absolute)),
});

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
    displayPath: displayedPathOf(intent.path, io.cwd),
  });
};

const runUndo = async (
  intent: Extract<Runnable, { kind: "undo" }>,
  cwd: string,
): Promise<string> => {
  const paths = withinWorkspace({ workspace: intent.workspace, absolute: intent.path });
  return undoCommand({
    path: paths.file,
    workspace: paths.workspace,
    json: intent.json,
    displayPath: displayedPathOf(intent.path, cwd),
  });
};

const LLM_KEY_ENV = "OPENCODE_API_KEY";

/** 写别处是合法用法（导出到任意目录），但那样 `--tone <id>` 找不到它：提示，不是错误。 */
const hintIfUndiscovered = (
  out: string | undefined,
  id: string,
  workspace: string,
  io: CliIo,
): void => {
  if (out === undefined) return;
  const deps = nodeStyleDeps(workspace);
  if (!isDiscoveredStylePath(out, id, deps)) io.stderr(undiscoveredHint(out, id, deps));
};

/** 提示按用户视角（相对 cwd）展示；判定仍拿 canonical 串自己做，展示与判定互不影响。 */
const displayedOutOf = (out: string | undefined, cwd: string): string | undefined =>
  out === undefined ? undefined : relative(cwd, out);

/** 传输层只在这里构造：`commands/*` 不许碰 env，网络实现也不该知道 flag 从哪来。 */
const llmOf = (
  intent: Extract<Intent, { kind: "styleExtract" }>,
  fetch: typeof globalThis.fetch | undefined,
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): LlmPort =>
  createLlmClient({
    apiKey: key,
    baseUrl: normalizeBaseUrl(intent.baseUrl ?? baseUrlOf(env)),
    model: intent.model ?? modelOf(env),
    sessionId: sessionIdOf(env),
    timeoutMs: LLM_TIMEOUT_MS,
    fetch: fetch ?? globalThis.fetch,
  });

const runExtract = async (
  intent: Extract<Runnable, { kind: "styleExtract" }>,
  io: ResolvedIo,
): Promise<string> => {
  const env = io.env;
  const key = apiKeyOf(env);
  // 没 key 是正常路径，不是错误——只在 stderr 说明一句，产物与 --no-llm 完全一致。
  if (key === undefined) io.stderr(`未设置 ${LLM_KEY_ENV}，仅用统计结果\n`);
  const llm = key === undefined || intent.noLlm ? undefined : llmOf(intent, io.fetch, env, key);
  if (!intent.idGiven) io.stderr(`未给 --id，使用默认值：${intent.id}\n`); // 默认值只提示，不拦
  if (!intent.nameGiven) io.stderr(`未给 --name，使用默认值：${intent.name}\n`);
  if (intent.files.length === 1) io.stderr("单篇语料的规则会很窄：建议 3 篇以上\n");
  const workspace = workspaceRealpathOf(intent.workspace);
  const out = intent.out === undefined ? undefined : realpathThroughAncestors(intent.out);
  // 写成功之后才提示：被 `--out` 占用/语料超限/LLM 失败挡下时什么都没写，提前提示读起来像"已经写了"。
  const written = await styleExtractCommand({
    files: intent.files,
    workspace,
    id: intent.id,
    name: intent.name,
    inheritsVisual: intent.inheritsVisual,
    out: out === undefined ? undefined : relative(workspace, out),
    force: intent.force,
    json: intent.json,
    llm,
    displayOut: intent.out === undefined ? undefined : displayedPathOf(intent.out, io.cwd),
  });
  hintIfUndiscovered(displayedOutOf(intent.out, io.cwd), intent.id, workspace, io);
  return written;
};

const runExport = async (
  intent: Extract<Runnable, { kind: "export" }>,
  io: CliIo,
): Promise<string> => {
  const paths = withinWorkspace({ workspace: intent.workspace, absolute: intent.path });
  const out = intent.out === undefined ? undefined : realpathThroughAncestors(intent.out);
  return exportPrintCommand({
    path: join(paths.workspace, paths.file),
    visual: intent.visual,
    out,
    force: intent.force,
    workspace: paths.workspace,
    json: intent.json,
    warn: io.stderr,
    displayOut: intent.out === undefined ? undefined : displayedPathOf(intent.out, io.cwd),
  });
};

/** 新文档的落点与 `--out` 同一口径：两侧都换成真实路径，越界判定交给命令层。 */
const runNew = (intent: Extract<Runnable, { kind: "new" }>, cwd: string): Promise<string> =>
  newDocCommand({
    ...intent,
    path: realpathThroughAncestors(intent.path),
    workspace: workspaceRealpathOf(intent.workspace),
    displayPath: displayedPathOf(intent.path, cwd),
  });

/** `env`/`stop`/`home` 在 `CliIo` 里可省；归一到 `ResolvedIo`，下游命令才不必判空（`stop` 的永不兑现是故意的）。 */
type ResolvedIo = CliIo & Required<Pick<CliIo, "env" | "stop" | "home">>;
const resolvedIoOf = (io: CliIo): ResolvedIo => ({
  ...io,
  env: io.env ?? {},
  stop: io.stop ?? new Promise<void>(() => undefined),
  home: io.home ?? homedir(),
});

/** `--home` 只有 serve 会用到；缺省落点已经由 `resolvedIoOf` 归一。 */
const runServe = async (
  intent: Extract<Runnable, { kind: "serve" }>,
  io: ResolvedIo,
): Promise<string> =>
  serveCommandOf(intent, withinWorkspace({ workspace: intent.workspace, absolute: intent.path }), {
    home: intent.home === undefined ? io.home : homeRealpathOf(intent.home),
    cwd: io.cwd,
    stop: io.stop,
    launchParentPid: io.launchParentPid,
    diagnose: io.stderr,
    displayPath: displayedPathOf(intent.path, io.cwd),
  });

/** 分发层归一好的三样：展示口径（`cwd`）、停止口、env 快照；`warn` 是 stderr 的非致命通道。 */
interface ProductIo {
  readonly cwd: string;
  readonly stop: Promise<void>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly warn: (message: string) => void;
}

/** 纸/超时/大纲这类字段意图层与命令层同名：整体透传，只换算路径相关的三项。 */
const pdfOf = (
  intent: Extract<Intent, { kind: "pdf" }>,
  paths: { readonly workspace: string; readonly file: string },
  io: ProductIo,
): Promise<string> =>
  pdfCommand({
    ...intent,
    path: join(paths.workspace, paths.file),
    out: realpathThroughAncestors(intent.out),
    workspace: paths.workspace,
    warn: io.warn,
    displayOut: displayedPathOf(intent.out, io.cwd),
    render: (renderInput) =>
      renderPdfOf({ ...renderInput, stop: io.stop, deps: chromeDepsOf(io.env) }),
  });

/** 长图尺寸在会话层定；这里只把视口参数与停止口接上（命令层不碰进程）。 */
const pngOf = (
  intent: Extract<Intent, { kind: "png" }>,
  paths: { readonly workspace: string; readonly file: string },
  io: ProductIo,
): Promise<string> =>
  pngCommand({
    ...intent,
    path: join(paths.workspace, paths.file),
    out: realpathThroughAncestors(intent.out),
    workspace: paths.workspace,
    warn: io.warn,
    displayOut: displayedPathOf(intent.out, io.cwd),
    render: (renderInput) =>
      renderPngOf({ ...renderInput, stop: io.stop, deps: chromeDepsOf(io.env) }),
  });

/** 产物命令的注入面：与 `ResolvedIo` 同源的四个字段，只给命令层看得到的部分。 */
const productIoOf = (io: ResolvedIo): ProductIo => ({
  cwd: io.cwd,
  stop: io.stop,
  env: io.env,
  warn: io.stderr,
});

/** 源按读命令的口径解（workspace 外也允许读）；`--out` 的越界判定在命令层，与 `hr export` 同一套。 */
const runImport = async (
  intent: Extract<Runnable, { kind: "import" }>,
  io: CliIo,
): Promise<string> => {
  const paths = withinWorkspace({ workspace: intent.workspace, absolute: intent.path });
  return importDocCommand({
    path: join(paths.workspace, paths.file),
    out: realpathThroughAncestors(intent.out),
    docKind: intent.docKind,
    title: intent.title,
    workspace: paths.workspace,
    force: intent.force,
    json: intent.json,
    displayOut: displayedPathOf(intent.out, io.cwd),
  });
};

type RemainingKind =
  "patch" | "pdf" | "png" | "serve" | "undo" | "styleExtract" | "normalize" | "style" | "import";

/** 剩下一半都要 io（或要走写盘路径）：两段各守一半，圈复杂度不随命令数线性增长。 */
const runRemaining = async (
  intent: Extract<Runnable, { kind: RemainingKind }>,
  io: ResolvedIo,
): Promise<string> => {
  if (intent.kind === "normalize" || intent.kind === "style") {
    const paths = withinWorkspace({ workspace: intent.workspace, absolute: intent.path });
    const displayPath = displayedPathOf(intent.path, io.cwd);
    return intent.kind === "normalize"
      ? normalizeCommand({ ...intent, path: paths.file, workspace: paths.workspace, displayPath })
      : styleCommand({ ...intent, path: paths.file, workspace: paths.workspace, displayPath });
  }
  if (intent.kind === "pdf" || intent.kind === "png") {
    const paths = withinWorkspace({ workspace: intent.workspace, absolute: intent.path });
    return intent.kind === "pdf"
      ? pdfOf(intent, paths, productIoOf(io))
      : pngOf(intent, paths, productIoOf(io));
  }
  if (intent.kind === "serve") return runServe(intent, io);
  if (intent.kind === "undo") return runUndo(intent, io.cwd);
  if (intent.kind === "import") return runImport(intent, io);
  if (intent.kind === "styleExtract") return runExtract(intent, io);
  return runPatch(intent, io);
};

const runIntent = async (intent: Runnable, io: ResolvedIo): Promise<string> => {
  if (intent.kind === "outline")
    return outlineCommand({
      ...intent,
      displayPath: displayedPathOf(intent.path, io.cwd),
      warn: io.stderr,
    });
  if (intent.kind === "read") return readCommand(intent);
  if (intent.kind === "check") {
    return checkCommand({ ...intent, displayPath: displayedPathOf(intent.path, io.cwd) });
  }
  if (intent.kind === "new") return runNew(intent, io.cwd);
  return intent.kind === "export" ? runExport(intent, io) : await runRemaining(intent, io);
};

const usageFailure = (message: string, topic: CommandName | undefined, io: CliIo): number => {
  io.stderr(`${term(message)}\n${usageText(topic)}`);
  return EXIT_USAGE;
};

/** `styleExtract` 是 `style` 的子命令：帮助与用法错误都落到 `style` 那段。 */
const topicOf = (kind: Runnable["kind"]): CommandName => (kind === "styleExtract" ? "style" : kind);

const reportFailure = (error: unknown, json: boolean, io: CliIo): number => {
  if (!(error instanceof HrError)) {
    io.stderr(`${term(error instanceof Error ? error.message : String(error))}\n`);
    if (io.debug && error instanceof Error) io.stderr(`${error.stack ?? ""}\n`);
    return EXIT_INTERNAL;
  }
  // 只走一条通道：`--json` 的消费者常把 `2>&1` 当真源，再写一遍 stderr 就多出第二段。
  if (json) io.stdout(jsonError(error.code, error.message, error.data));
  else {
    io.stderr(`${term(error.message)}\n`);
    if (error instanceof HintedError) io.stderr(term(error.hint));
  }
  return exitCodeOf(error.code);
};

export const run = async (argv: readonly string[], io: CliIo): Promise<number> => {
  const parsed = parseArgs(argv, io.cwd);
  if (!parsed.ok) return usageFailure(parsed.message, parsed.topic, io);
  if (parsed.intent.kind === "help") {
    io.stdout(usageText(parsed.intent.topic));
    return EXIT_OK;
  }
  const { json } = parsed.intent;
  const topic = topicOf(parsed.intent.kind);
  try {
    io.stdout(await runIntent(parsed.intent, resolvedIoOf(io)));
    return EXIT_OK;
  } catch (error: unknown) {
    if (error instanceof UsageError) return usageFailure(error.message, topic, io);
    if (error instanceof StrictFailure) {
      // 报告是契约输出（`--json` 时仍是单行 envelope）：先原样进 stdout，错误行只走 stderr。
      io.stdout(error.report);
      io.stderr(`${term(error.message)}\n`);
      return EXIT_FAILURE;
    }
    return reportFailure(error, json, io);
  }
};
