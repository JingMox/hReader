// Pure argv -> intent entry point (never touches process, does no IO, throws nothing); CLI usage errors (exit 2) all funnel through here.

import { resolve } from "node:path";

import { COMMAND_NAMES, isCommandName, type CommandName } from "../usage";
import { annotationsIntent } from "./annotations";
import {
  checkIntent,
  importIntent,
  newIntent,
  normalizeIntent,
  outlineIntent,
  patchIntent,
  plainIntent,
  readIntent,
} from "./authoring";
import { exportIntent, pdfIntent, pngIntent } from "./export";
import { commonOf, failure, intInRange, unusedFlag, absoluteOf, type ParsedArgs } from "./intent";
import { allowHostsOf, tokenize, type Raw } from "./raw";
import { styleIntent } from "./style";
import { templateIntent } from "./template";

export type { HtmlSource, Intent, ParsedArgs, StrictLevel, StyleMode } from "./intent";

const MAX_PORT = 65_535;

const SERVE_FLAGS = [
  "--json",
  "--port",
  "--workspace",
  "--allow-host",
  "--app-dir",
  "--home",
  "--exit-with-parent",
];

const serveIntent = (raw: Raw, rest: readonly string[], cwd: string): ParsedArgs => {
  const [file = "", ...extra] = rest;
  const message =
    extra.length > 0
      ? `serve 只接受 1 个位置参数，多出 ${String(extra.length)} 个`
      : file === ""
        ? "serve 缺少 <file>"
        : unusedFlag(raw, SERVE_FLAGS);
  if (message !== undefined) return failure(message, "serve");
  const port = intInRange(raw, "--port", 0, MAX_PORT) ?? 0;
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
      // The default must stay undefined: core uses it to pick the built-in fallback page.
      appDir: appDirRaw === undefined ? undefined : resolve(cwd, appDirRaw),
      appDirGiven: appDirRaw !== undefined,
      home: homeRaw === undefined ? undefined : resolve(cwd, homeRaw),
      exitWithParent: raw.switches.has("--exit-with-parent"),
      ...commonOf(raw, cwd),
    },
  };
};

const META_FLAGS = [
  "--json",
  "--workspace",
  "--tag",
  "--untag",
  "--source-url",
  "--clear-source-url",
];

const metaIntent = (raw: Raw, rest: readonly string[], cwd: string): ParsedArgs => {
  const [file = "", ...extra] = rest;
  let message =
    extra.length > 0
      ? `meta 只接受 1 个位置参数，多出 ${String(extra.length)} 个`
      : file === ""
        ? "meta 缺少 <file>"
        : unusedFlag(raw, META_FLAGS);
  if (
    message === undefined &&
    raw.switches.has("--clear-source-url") &&
    raw.values.has("--source-url")
  ) {
    message = "--source-url 与 --clear-source-url 不能同用";
  }
  if (message !== undefined) return failure(message, "meta");
  return {
    ok: true,
    intent: {
      kind: "meta",
      path: absoluteOf(file, cwd),
      tags: raw.tags,
      untags: raw.untags,
      sourceUrl: raw.values.get("--source-url"),
      clearSourceUrl: raw.switches.has("--clear-source-url"),
      ...commonOf(raw, cwd),
    },
  };
};

const SEARCH_FLAGS = ["--json", "--limit", "--workspace"];

/** `SEARCH_LIMITS.limitMax` pinned in the flag's range message: core owns the real bound. */
const searchIntent = (raw: Raw, rest: readonly string[], cwd: string): ParsedArgs => {
  const [query = "", ...extra] = rest;
  const message =
    extra.length > 0
      ? `search 只接受 1 个位置参数，多出 ${String(extra.length)} 个`
      : query === ""
        ? "search 缺少 <query>"
        : unusedFlag(raw, SEARCH_FLAGS);
  if (message !== undefined) return failure(message, "search");
  // Decimal digits only, same contract as GET /api/search — Number() spellings die here.
  const rawLimit = raw.values.get("--limit");
  const limit =
    rawLimit !== undefined && !/^[0-9]+$/u.test(rawLimit)
      ? "invalid"
      : intInRange(raw, "--limit", 1, 100);
  if (limit === "invalid") return failure("--limit 必须是 1..100 的整数", "search");
  return {
    ok: true,
    intent: { kind: "search", query, limit, ...commonOf(raw, cwd) },
  };
};

type IntentBuilder = (raw: Raw, rest: readonly string[], cwd: string) => ParsedArgs;

/** One table instead of an if chain: each new command adds one row, and `build`'s cyclomatic complexity stays flat. */
const BUILDERS: Readonly<Record<CommandName, IntentBuilder>> = {
  new: newIntent,
  import: importIntent,
  normalize: normalizeIntent,
  outline: outlineIntent,
  read: readIntent,
  patch: patchIntent,
  check: checkIntent,
  style: styleIntent,
  undo: plainIntent,
  export: exportIntent,
  pdf: pdfIntent,
  png: pngIntent,
  serve: serveIntent,
  template: templateIntent,
  annotations: annotationsIntent,
  meta: metaIntent,
  search: searchIntent,
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
