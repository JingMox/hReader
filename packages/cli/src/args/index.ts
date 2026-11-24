// argv → 意图的纯函数入口（不读 process、不做 IO、不抛异常）；CLI 用法错误（exit 2）在这里汇聚。

import { resolve } from "node:path";

import { COMMAND_NAMES, isCommandName, type CommandName } from "../usage";
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
      // 缺省必须留 undefined：core 据此走默认兜底页面。
      appDir: appDirRaw === undefined ? undefined : resolve(cwd, appDirRaw),
      appDirGiven: appDirRaw !== undefined,
      home: homeRaw === undefined ? undefined : resolve(cwd, homeRaw),
      exitWithParent: raw.switches.has("--exit-with-parent"),
      ...commonOf(raw, cwd),
    },
  };
};

type IntentBuilder = (raw: Raw, rest: readonly string[], cwd: string) => ParsedArgs;

/** 一张表代替 if 链：每加一个命令只多一行，`build` 的圈复杂度不随之增长。 */
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
