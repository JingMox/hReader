// This layer: argv -> intent -> command -> exit code (the CLI's io contract and error funnel); usage errors go to stderr only with exit 2, `--help` is always 0.
// No parsing, no formatting; process-coupled io lives in the untestable `main.ts`, all logic stays in this file.

import { homedir } from "node:os";
import { join, relative } from "node:path";

import { HrError, nodeStyleDeps } from "@hreader/core";

import { parseArgs, type Intent } from "./args";
import { attemptRealpath, realpathThroughAncestors } from "./canonical";
import { chromeDepsOf, renderPdfOf, renderPngOf } from "./chrome/session";
import { annotationsListCommand, annotationsMigrateCommand } from "./commands/annotations";
import { checkCommand } from "./commands/check";
import { exportPrintCommand } from "./commands/export-print";
import { importDocCommand } from "./commands/import";
import { metaCommand } from "./commands/meta";
import { newDocCommand } from "./commands/new";
import { normalizeCommand } from "./commands/normalize";
import { outlineCommand } from "./commands/outline";
import { patchCommand } from "./commands/patch";
import { pdfCommand } from "./commands/pdf";
import { pngCommand } from "./commands/png";
import { readCommand } from "./commands/read";
import { searchCommand } from "./commands/search";
import { styleCommand } from "./commands/style";
import { styleExtractCommand } from "./commands/style-extract";
import { thumbCommand } from "./commands/thumb";
import {
  templateListCommand,
  templateNewCommand,
  templateSaveCommand,
  templateShowCommand,
} from "./commands/template";
import { undoCommand } from "./commands/undo";
import { HintedError, StrictFailure } from "./errors";
import { EXIT_FAILURE, EXIT_INTERNAL, EXIT_OK, EXIT_USAGE, exitCodeOf } from "./exit-codes";
import { sourceText } from "./input";
import { LLM_TIMEOUT_MS, createLlmClient, type LlmPort } from "./llm/client";
import { apiKeyOf, baseUrlOf, modelOf, normalizeBaseUrl, sessionIdOf } from "./llm/session";
import { bounded, displayedPathOf, jsonError, term } from "./output";
import { serveCommandOf } from "./run-serve";
import { isDiscoveredStylePath, undiscoveredHint } from "./style-out";
import { createThumbRender } from "./thumbs/service";
import { usageText, type CommandName } from "./usage";

export interface CliIo {
  readonly cwd: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly readStdin: () => Promise<Uint8Array>;
  readonly debug: boolean;
  /** env snapshot: `process.env` is read once, in `main.ts` (unset = no key); tests inject fake keys through this. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Network injection point for the LLM branch: unset = real `fetch`; tests replay `fixtures/llm/` through it. */
  readonly fetch?: typeof globalThis.fetch;
  /** serve uses it to observe SIGTERM/SIGINT; other commands do not need it (omittable when building io in tests). */
  readonly stop?: Promise<void>;
  /** Binary stdout channel for `hr thumb` without `--out` (`process.stdout.write` at the boundary); text receipts keep going through `stdout`. */
  readonly stdoutBytes?: (bytes: Uint8Array) => void;
  /** `process.stdout.isTTY` read once at the boundary: the TTY rule lives in the command layer, which must not touch the tty itself. */
  readonly isStdoutTty?: boolean;
  /** The parent pid at startup: **required**, only `main.ts` can capture it before the first `await` (a `?? process.ppid` fallback would write the "read late" bug back in). */
  readonly launchParentPid: number;
  readonly home?: string;
}

/** stdin decoded fine but is empty: a usage error (not core's `invalid_fragment`). */
class UsageError extends Error {}

type Runnable = Exclude<Intent, { readonly kind: "help" }>;
/** Write-command input: both sides realpath before going relative; when workspace is missing the same baseline is used and `ENOENT` is core's to report. */
const workspaceRealpathOf = (workspace: string): string => {
  const real = attemptRealpath(workspace);
  if (real === undefined) throw new UsageError(`--workspace 不存在：${workspace}`);
  return real;
};
/** `--home` follows `--workspace`'s rule: only accepted when it exists (`.hreader/` is core's to create — home itself is never created). */
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

/** Writing elsewhere is legitimate (export to any directory), but then `--tone <id>` cannot find it: a hint, not an error. */
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

/** The hint displays from the user's view (relative to cwd); the check still runs on the canonical string — display and judgment do not affect each other. */
const displayedOutOf = (out: string | undefined, cwd: string): string | undefined =>
  out === undefined ? undefined : relative(cwd, out);

/** The transport is built only here: `commands/*` must not touch env, and the network implementation should not know where flags come from. */
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
  // No key is a normal path, not an error — one stderr note suffices; the product is identical to --no-llm.
  if (key === undefined) io.stderr(`未设置 ${LLM_KEY_ENV}，仅用统计结果\n`);
  const llm = key === undefined || intent.noLlm ? undefined : llmOf(intent, io.fetch, env, key);
  if (!intent.idGiven) io.stderr(`未给 --id，使用默认值：${intent.id}\n`); // only noted, never blocked
  if (!intent.nameGiven) io.stderr(`未给 --name，使用默认值：${intent.name}\n`);
  if (intent.files.length === 1) io.stderr("单篇语料的规则会很窄：建议 3 篇以上\n");
  const workspace = workspaceRealpathOf(intent.workspace);
  const out = intent.out === undefined ? undefined : realpathThroughAncestors(intent.out);
  // Hint only after a successful write: when `--out` collision / corpus cap / LLM failure blocks it, nothing was written and an early hint would read like "already written".
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

/** The new document's destination follows `--out`'s convention: both sides realpath, out-of-bounds belongs to the command layer. */
const runNew = (intent: Extract<Runnable, { kind: "new" }>, cwd: string): Promise<string> =>
  newDocCommand({
    ...intent,
    path: realpathThroughAncestors(intent.path),
    workspace: workspaceRealpathOf(intent.workspace),
    displayPath: displayedPathOf(intent.path, cwd),
  });

/**
 * `HREADER_HOME` relocates the config root (`<home>/.hreader/`) without
 * redirecting `$HOME` — the spawned Chrome inherits `HOME` too, and an
 * unwritable/empty one leaves its network stack stuck before requests exist.
 */
const configHomeOf = (io: CliIo): string => {
  if (io.home !== undefined) return io.home;
  const envHome = io.env?.["HREADER_HOME"];
  return envHome === undefined || envHome === "" ? homedir() : envHome;
};

/** `env`/`stop`/`home`/the stdout extras are optional on `CliIo`; normalizing into `ResolvedIo` spares downstream commands the null checks (`stop` never resolving is deliberate). */
type ResolvedIo = CliIo &
  Required<Pick<CliIo, "env" | "stop" | "home" | "stdoutBytes" | "isStdoutTty">>;
const resolvedIoOf = (io: CliIo): ResolvedIo => ({
  ...io,
  env: io.env ?? {},
  stop: io.stop ?? new Promise<void>(() => undefined),
  home: configHomeOf(io),
  stdoutBytes: io.stdoutBytes ?? (() => undefined),
  isStdoutTty: io.isStdoutTty ?? false,
});

/** Only serve uses `--home`; the default location is already normalized by `resolvedIoOf`. */
const runServe = async (
  intent: Extract<Runnable, { kind: "serve" }>,
  io: ResolvedIo,
): Promise<string> =>
  serveCommandOf(intent, withinWorkspace({ workspace: intent.workspace, absolute: intent.path }), {
    home: intent.home === undefined ? io.home : homeRealpathOf(intent.home),
    env: io.env,
    cwd: io.cwd,
    stop: io.stop,
    launchParentPid: io.launchParentPid,
    diagnose: io.stderr,
    displayPath: displayedPathOf(intent.path, io.cwd),
  });

/** The dispatch layer's normalized trio: display convention (`cwd`), stop handle, env snapshot; `warn` is stderr's non-fatal channel. `home` feeds the foreign-doc permission lookup in pdf/png. */
interface ProductIo {
  readonly cwd: string;
  readonly stop: Promise<void>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly warn: (message: string) => void;
}

/** Fields like paper/timeout/outline share names between intent and command layers: pass through wholesale; only the three path-related ones are converted. */
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
    home: io.home,
    warn: io.warn,
    displayOut: displayedPathOf(intent.out, io.cwd),
    render: (renderInput) =>
      renderPdfOf({ ...renderInput, stop: io.stop, deps: chromeDepsOf(io.env) }),
  });

/** Tall-image dimensions are settled in the session layer; this only wires viewport params and the stop handle (the command layer never touches the process). */
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
    home: io.home,
    warn: io.warn,
    displayOut: displayedPathOf(intent.out, io.cwd),
    render: (renderInput) =>
      renderPngOf({ ...renderInput, stop: io.stop, deps: chromeDepsOf(io.env) }),
  });

/** Injection surface for product commands: the four fields sourced from `ResolvedIo`, exposing only what the command layer may see. */
const productIoOf = (io: ResolvedIo): ProductIo => ({
  cwd: io.cwd,
  stop: io.stop,
  env: io.env,
  home: io.home,
  warn: io.stderr,
});

/** `hr thumb` needs everything pdf/png do plus the stdout boundary (binary write + TTY check) — same surface, two more fields. */
const thumbOf = (
  intent: Extract<Intent, { kind: "thumb" }>,
  paths: { readonly workspace: string; readonly file: string },
  io: ProductIo & Pick<ResolvedIo, "stdoutBytes" | "isStdoutTty">,
): Promise<string> =>
  thumbCommand({
    ...intent,
    path: join(paths.workspace, paths.file),
    out: intent.out === undefined ? undefined : realpathThroughAncestors(intent.out),
    workspace: paths.workspace,
    displayOut: intent.out === undefined ? undefined : displayedPathOf(intent.out, io.cwd),
    isStdoutTty: io.isStdoutTty,
    stdoutBytes: io.stdoutBytes,
    // The whole pipeline (queue + cache + Chrome) is the injected `render`: one service per invocation.
    render: createThumbRender({
      workspace: paths.workspace,
      home: io.home,
      env: io.env,
      stop: io.stop,
      timeoutMs: intent.timeoutMs,
      warn: io.warn,
      visual: intent.visual,
    }),
  });

/** The source resolves like a read command (reads outside workspace are allowed); `--out`'s bounds check is the command layer's, same set as `hr export`. */
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

type TemplateKind = "templateList" | "templateShow" | "templateNew" | "templateSave";

/** One home resolution for all four subcommands: `--home` must exist (like serve); the default is `resolvedIoOf`'s `HREADER_HOME`-aware value. */
const runTemplate = async (
  intent: Extract<Runnable, { kind: TemplateKind }>,
  io: ResolvedIo,
): Promise<string> => {
  const home = intent.home === undefined ? io.home : homeRealpathOf(intent.home);
  if (intent.kind === "templateList") {
    return templateListCommand({
      workspace: workspaceRealpathOf(intent.workspace),
      home,
      json: intent.json,
      warn: io.stderr,
    });
  }
  if (intent.kind === "templateShow") {
    return templateShowCommand({
      id: intent.id,
      workspace: workspaceRealpathOf(intent.workspace),
      home,
      json: intent.json,
    });
  }
  const paths = withinWorkspace({ workspace: intent.workspace, absolute: intent.path });
  return intent.kind === "templateNew"
    ? templateNewCommand({
        file: paths.file,
        template: intent.template,
        title: intent.title,
        workspace: paths.workspace,
        home,
        json: intent.json,
        displayPath: displayedPathOf(intent.path, io.cwd),
      })
    : templateSaveCommand({
        file: paths.file,
        id: intent.id,
        global: intent.global,
        name: intent.name,
        description: intent.description,
        workspace: paths.workspace,
        home,
        json: intent.json,
        cwd: io.cwd,
      });
};

type RemainingKind =
  | "patch"
  | "pdf"
  | "png"
  | "thumb"
  | "serve"
  | "undo"
  | "styleExtract"
  | "normalize"
  | "style"
  | "import";

/** The other half all need io (or take the write path): two segments each holding half — cyclomatic complexity stays flat as commands are added. */
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
  if (intent.kind === "pdf" || intent.kind === "png" || intent.kind === "thumb") {
    const paths = withinWorkspace({ workspace: intent.workspace, absolute: intent.path });
    if (intent.kind === "thumb") return thumbOf(intent, paths, { ...productIoOf(io), ...io });
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
  if (intent.kind === "annotationsList" || intent.kind === "annotationsMigrate") {
    const paths = withinWorkspace({ workspace: intent.workspace, absolute: intent.path });
    const displayPath = displayedPathOf(intent.path, io.cwd);
    return intent.kind === "annotationsList"
      ? annotationsListCommand({
          path: paths.file,
          workspace: paths.workspace,
          status: intent.status,
          json: intent.json,
          warn: io.stderr,
          displayPath,
        })
      : annotationsMigrateCommand({
          path: paths.file,
          workspace: paths.workspace,
          json: intent.json,
          warn: io.stderr,
          displayPath,
        });
  }
  if (intent.kind === "meta") {
    const paths = withinWorkspace({ workspace: intent.workspace, absolute: intent.path });
    return metaCommand({
      path: paths.file,
      workspace: paths.workspace,
      tags: intent.tags,
      untags: intent.untags,
      sourceUrl: intent.sourceUrl,
      clearSourceUrl: intent.clearSourceUrl,
      json: intent.json,
      warn: io.stderr,
    });
  }
  if (intent.kind === "search") {
    return searchCommand({
      query: intent.query,
      limit: intent.limit,
      workspace: workspaceRealpathOf(intent.workspace),
      json: intent.json,
      warn: io.stderr,
    });
  }
  if (intent.kind === "new") return runNew(intent, io.cwd);
  if (
    intent.kind === "templateList" ||
    intent.kind === "templateShow" ||
    intent.kind === "templateNew" ||
    intent.kind === "templateSave"
  ) {
    return runTemplate(intent, io);
  }
  return intent.kind === "export" ? runExport(intent, io) : await runRemaining(intent, io);
};

const usageFailure = (message: string, topic: CommandName | undefined, io: CliIo): number => {
  io.stderr(`${term(message)}\n${usageText(topic)}`);
  return EXIT_USAGE;
};

/** `styleExtract` is a `style` subcommand and all `template*`/`annotations*` intents report under their own sections: help and usage errors land in the matching section. */
const topicOf = (kind: Runnable["kind"]): CommandName => {
  if (kind === "styleExtract") return "style";
  if (kind.startsWith("template")) return "template";
  return kind.startsWith("annotations") ? "annotations" : (kind as CommandName);
};

const reportFailure = (error: unknown, json: boolean, io: CliIo): number => {
  if (!(error instanceof HrError)) {
    io.stderr(`${term(error instanceof Error ? error.message : String(error))}\n`);
    if (io.debug && error instanceof Error) io.stderr(`${error.stack ?? ""}\n`);
    return EXIT_INTERNAL;
  }
  // One channel only: `--json` consumers often treat `2>&1` as the source of truth — writing stderr a second time adds a stray section.
  if (json) io.stdout(jsonError(error.code, error.message, error.data));
  else {
    io.stderr(`${term(error.message)}\n`);
    if (error instanceof HintedError) io.stderr(term(error.hint));
  }
  return exitCodeOf(error.code);
};

export const run = async (argv: readonly string[], io: CliIo): Promise<number> => {
  // stderr is a pure diagnostics channel: every write passes a length cap first — echoing a giant input must not stall the terminal/log pipeline.
  const stderr = io.stderr;
  io = {
    ...io,
    stderr: (text) => {
      stderr(bounded(text));
    },
  };
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
      // The report is contract output (still a single-line envelope under `--json`): it enters stdout verbatim first; error lines go to stderr only.
      io.stdout(error.report);
      io.stderr(`${term(error.message)}\n`);
      return EXIT_FAILURE;
    }
    return reportFailure(error, json, io);
  }
};
