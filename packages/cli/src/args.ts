// argv → 意图的纯函数（不读 process、不做 IO、不抛异常）；CLI 用法错误（exit 2）全部在这里产生。
import { resolve } from "node:path";

import { type PatchAction } from "@hreader/core";

import { extractIntent } from "./args-extract";
import { pdfIntent } from "./args-pdf";
import { pngIntent } from "./args-png";
import { exportIntent } from "./args-export";
import { newIntent } from "./args-new";
import { absoluteOf, commonOf, failure, unusedFlag, type ParsedArgs } from "./intent";
import type { HtmlSource, StyleMode } from "./intent";
import { allowHostsOf, tokenize, type Raw } from "./tokens";
import { COMMAND_NAMES, isCommandName, type CommandName } from "./usage";

// `input.ts` / `run.ts` / `commands/*` 都从 `./args` 取这些名字：真正的定义在 `intent.ts`（避免循环 import）。
export type { HtmlSource, Intent, ParsedArgs, StyleMode } from "./intent";

const MAX_BYTES_CEILING = 10_000_000;

const ACTIONS: readonly string[] = ["replace", "insert_before", "insert_after", "append", "delete"];

const isAction = (value: string): value is PatchAction => ACTIONS.includes(value);

/** 只补 id、不碰其它字节：`--write` 才落盘，不给就只把结果打到 stdout。 */
const normalizeIntent = (raw: Raw, rest: readonly string[], cwd: string): ParsedArgs => {
  const [file = "", ...extra] = rest;
  const problem =
    extra.length > 0
      ? `normalize 只接受 1 个位置参数，多出 ${String(extra.length)} 个`
      : file === ""
        ? "normalize 缺少 <file>"
        : unusedFlag(raw, ["--json", "--write", "--workspace"]);
  if (problem !== undefined) return failure(problem, "normalize");
  return {
    ok: true,
    intent: {
      kind: "normalize",
      path: absoluteOf(file, cwd),
      write: raw.switches.has("--write"),
      ...commonOf(raw, cwd),
    },
  };
};

const outlineIntent = (raw: Raw, rest: readonly string[], cwd: string): ParsedArgs => {
  const [file = "", ...extra] = rest;
  const problem =
    extra.length > 0
      ? `outline 只接受 1 个位置参数，多出 ${String(extra.length)} 个`
      : file === ""
        ? "outline 缺少 <file>"
        : unusedFlag(raw, ["--json", "--workspace"]);
  if (problem !== undefined) return failure(problem, "outline");
  return {
    ok: true,
    intent: { kind: "outline", path: absoluteOf(file, cwd), ...commonOf(raw, cwd) },
  };
};

const maxBytesOf = (raw: Raw): number | undefined | "invalid" => {
  const value = raw.values.get("--max-bytes");
  if (value === undefined) return undefined;
  const parsed = Number(value);
  const legal = Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_BYTES_CEILING;
  return legal ? parsed : "invalid";
};

const readIntent = (raw: Raw, rest: readonly string[], cwd: string): ParsedArgs => {
  const [file = "", target = "", ...extra] = rest;
  const message =
    extra.length > 0
      ? `read 只接受 2 个位置参数，多出 ${String(extra.length)} 个`
      : file === ""
        ? "read 缺少 <file>"
        : target === ""
          ? "read 缺少 <nodeId|selector>"
          : unusedFlag(raw, ["--json", "--max-bytes", "--workspace"]);
  if (message !== undefined) return failure(message, "read");
  const maxBytes = maxBytesOf(raw);
  if (maxBytes === "invalid") {
    return failure(`--max-bytes 必须是 1..${String(MAX_BYTES_CEILING)} 的整数`, "read");
  }
  return {
    ok: true,
    intent: { kind: "read", path: absoluteOf(file, cwd), target, maxBytes, ...commonOf(raw, cwd) },
  };
};

type SourceResult =
  | { readonly ok: true; readonly source: HtmlSource | undefined }
  | { readonly ok: false; readonly message: string };

const sourceOf = (raw: Raw, action: PatchAction, cwd: string): SourceResult => {
  const inline = raw.values.get("--html");
  const file = raw.values.get("--html-file");
  const stdin = raw.switches.has("--html-stdin");
  const given = [inline !== undefined, file !== undefined, stdin].filter((hit) => hit).length;
  if (action === "delete") {
    return given === 0
      ? { ok: true, source: undefined }
      : { ok: false, message: "delete 不接受 --html / --html-file / --html-stdin" };
  }
  if (given !== 1) {
    return { ok: false, message: "--html / --html-file / --html-stdin 必须且只能给一个" };
  }
  if (inline !== undefined) return { ok: true, source: { kind: "inline", text: inline } };
  if (file !== undefined)
    return { ok: true, source: { kind: "file", path: absoluteOf(file, cwd) } };
  return { ok: true, source: { kind: "stdin" } };
};

const patchIntent = (raw: Raw, rest: readonly string[], cwd: string): ParsedArgs => {
  const [file = "", nodeId = "", ...extra] = rest;
  const message =
    extra.length > 0
      ? `patch 只接受 2 个位置参数，多出 ${String(extra.length)} 个`
      : file === ""
        ? "patch 缺少 <file>"
        : nodeId === ""
          ? "patch 缺少 <nodeId|selector>"
          : unusedFlag(raw, [
              "--action",
              "--html",
              "--html-file",
              "--html-stdin",
              "--json",
              "--workspace",
            ]);
  if (message !== undefined) return failure(message, "patch");
  const action = raw.values.get("--action");
  if (action === undefined) return failure("patch 缺少 --action", "patch");
  if (!isAction(action)) return failure(`未知的 --action：${action}`, "patch");
  const source = sourceOf(raw, action, cwd);
  if (!source.ok) return failure(source.message, "patch");
  const common = commonOf(raw, cwd);
  return {
    ok: true,
    intent: {
      kind: "patch",
      path: absoluteOf(file, cwd),
      nodeId,
      action,
      html: source.source,
      ...common,
    },
  };
};

const modeOf = (raw: Raw): StyleMode | undefined | "invalid" => {
  const visual = raw.values.get("--visual");
  const tone = raw.values.get("--tone");
  const lint = raw.switches.has("--lint");
  const given = [visual !== undefined, tone !== undefined, lint].filter((hit) => hit).length;
  if (given !== 1) return given === 0 ? undefined : "invalid";
  if (visual !== undefined) return { kind: "visual", id: visual };
  if (tone !== undefined) return { kind: "tone", id: tone };
  return { kind: "lint" };
};

const styleIntent = (raw: Raw, rest: readonly string[], cwd: string): ParsedArgs => {
  if (rest[0] === "extract") return extractIntent(raw, rest.slice(1), cwd);
  const [file = "", ...extra] = rest;
  const message =
    extra.length > 0
      ? `style 只接受 1 个位置参数，多出 ${String(extra.length)} 个`
      : file === ""
        ? "style 缺少 <file>"
        : unusedFlag(raw, ["--json", "--lint", "--tone", "--visual", "--workspace"]);
  if (message !== undefined) return failure(message, "style");
  const mode = modeOf(raw);
  if (mode === undefined)
    return failure("style 需要 --visual <id> / --tone <id> / --lint 之一", "style");
  if (mode === "invalid") return failure("--visual / --tone / --lint 必须且只能给一个", "style");
  const common = commonOf(raw, cwd);
  return {
    ok: true,
    intent: { kind: "style", path: absoluteOf(file, cwd), mode, ...common },
  };
};

const MAX_PORT = 65_535;

const portOf = (raw: Raw): number | "invalid" => {
  const value = raw.values.get("--port");
  if (value === undefined) return 0;
  const parsed = Number(value);
  const legal = Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_PORT;
  return legal ? parsed : "invalid";
};

const serveIntent = (raw: Raw, rest: readonly string[], cwd: string): ParsedArgs => {
  const [file = "", ...extra] = rest;
  const message =
    extra.length > 0
      ? `serve 只接受 1 个位置参数，多出 ${String(extra.length)} 个`
      : file === ""
        ? "serve 缺少 <file>"
        : unusedFlag(raw, [
            "--json",
            "--port",
            "--workspace",
            "--allow-host",
            "--app-dir",
            "--home",
            "--exit-with-parent",
          ]);
  if (message !== undefined) return failure(message, "serve");
  const port = portOf(raw);
  if (port === "invalid") return failure(`--port 必须是 0..${String(MAX_PORT)} 的整数`, "serve");
  const appDirRaw = raw.values.get("--app-dir");
  const homeRaw = raw.values.get("--home");
  return {
    ok: true,
    intent: {
      kind: "serve",
      path: absoluteOf(file, cwd),
      port,
      allowHosts: allowHostsOf(raw),
      // 缺省必须留 undefined：core 据此走 M2.1 的 200 兜底（裁定 R2-P0-2）。
      appDir: appDirRaw === undefined ? undefined : resolve(cwd, appDirRaw),
      appDirGiven: appDirRaw !== undefined,
      home: homeRaw === undefined ? undefined : resolve(cwd, homeRaw),
      exitWithParent: raw.switches.has("--exit-with-parent"),
      ...commonOf(raw, cwd),
    },
  };
};

const plainIntent = (
  raw: Raw,
  rest: readonly string[],
  cwd: string,
  kind: "undo" | "check",
): ParsedArgs => {
  const [file = "", ...extra] = rest;
  const problem =
    extra.length > 0
      ? `${kind} 只接受 1 个位置参数，多出 ${String(extra.length)} 个`
      : file === ""
        ? `${kind} 缺少 <file>`
        : unusedFlag(raw, ["--json", "--workspace"]);
  if (problem !== undefined) return failure(problem, kind);
  return { ok: true, intent: { kind, path: absoluteOf(file, cwd), ...commonOf(raw, cwd) } };
};

type IntentBuilder = (raw: Raw, rest: readonly string[], cwd: string) => ParsedArgs;

/** 一张表代替 if 链：每加一个命令只多一行，`build` 的圈复杂度不随之长。 */
const BUILDERS: Readonly<Record<CommandName, IntentBuilder>> = {
  new: newIntent,
  normalize: normalizeIntent,
  outline: outlineIntent,
  read: readIntent,
  patch: patchIntent,
  check: (raw, rest, cwd) => plainIntent(raw, rest, cwd, "check"),
  style: styleIntent,
  undo: (raw, rest, cwd) => plainIntent(raw, rest, cwd, "undo"),
  export: exportIntent,
  pdf: pdfIntent,
  png: pngIntent,
  serve: serveIntent,
};

const build = (raw: Raw, cwd: string): ParsedArgs => {
  const [name, ...rest] = raw.positionals;
  if (name === undefined) {
    return failure(`缺少命令：${COMMAND_NAMES.join(" | ")}`, undefined);
  }
  if (!isCommandName(name)) return failure(`未知命令：${name}`, undefined);
  return BUILDERS[name](raw, rest, cwd);
};

export const parseArgs = (argv: readonly string[], cwd: string): ParsedArgs => {
  const tokenized = tokenize(argv);
  if (!tokenized.ok) return failure(tokenized.message, undefined);
  const [first] = tokenized.raw.positionals;
  if (tokenized.raw.switches.has("--help")) {
    const topic: CommandName | undefined = isCommandName(first) ? first : undefined;
    return { ok: true, intent: { kind: "help", topic } };
  }
  return build(tokenized.raw, cwd);
};
