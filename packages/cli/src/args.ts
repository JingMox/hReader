// 这层管：argv → 意图的纯函数（不读 process、不做 IO、不抛异常）；错误用联合返回。
// CLI 层的用法错误（exit 2）全部在这里产生，core 的 `HrError` 在命令层才可能出现。

import { resolve } from "node:path";

import type { PatchAction } from "@hreader/core";

import { allowHostsOf, tokenize, type Raw } from "./tokens";
import { isCommandName, type CommandName } from "./usage";

export type HtmlSource =
  | { readonly kind: "inline"; readonly text: string }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "stdin" };

export type StyleMode =
  | { readonly kind: "visual"; readonly id: string }
  | { readonly kind: "tone"; readonly id: string }
  | { readonly kind: "lint" };

interface Common {
  readonly json: boolean;
  readonly workspace: string;
}

export type Intent =
  | { readonly kind: "help"; readonly topic: CommandName | undefined }
  | ({ readonly kind: "outline"; readonly path: string } & Common)
  | ({
      readonly kind: "read";
      readonly path: string;
      readonly target: string;
      readonly maxBytes: number | undefined;
    } & Common)
  | ({
      readonly kind: "patch";
      readonly path: string;
      readonly nodeId: string;
      readonly action: PatchAction;
      readonly html: HtmlSource | undefined;
    } & Common)
  | ({ readonly kind: "style"; readonly path: string; readonly mode: StyleMode } & Common)
  | ({
      readonly kind: "serve";
      readonly path: string;
      readonly port: number;
      readonly allowHosts: readonly string[] | undefined;
      /** 构建产物目录（`index.html` + `assets/`）；缺省 `packages/app/dist`。 */
      /** 显式 `--app-dir` 的绝对路径；未给就是 `undefined`（让 core 走 M2.1 的 200 兜底）。 */
      readonly appDir: string | undefined;
      /** 用户是否显式给了 `--app-dir`：`run.ts` 据此决定"目录不存在就 exit 2"。 */
      readonly appDirGiven: boolean;
    } & Common);

export type ParsedArgs =
  | { readonly ok: true; readonly intent: Intent }
  | {
      readonly ok: false;
      readonly message: string;
      readonly topic: CommandName | undefined;
    };

const MAX_BYTES_CEILING = 10_000_000;

const ACTIONS: readonly string[] = ["replace", "insert_before", "insert_after", "append", "delete"];

const isAction = (value: string): value is PatchAction => ACTIONS.includes(value);

const failure = (message: string, topic: CommandName | undefined): ParsedArgs => ({
  ok: false,
  message,
  topic,
});

const unusedFlag = (raw: Raw, allowed: readonly string[]): string | undefined => {
  for (const name of raw.values.keys()) {
    if (!allowed.includes(name)) return name;
  }
  for (const name of raw.switches) {
    if (!allowed.includes(name)) return name;
  }
  return undefined;
};

const commonOf = (raw: Raw, cwd: string): Common => ({
  json: raw.switches.has("--json"),
  workspace: resolve(cwd, raw.values.get("--workspace") ?? cwd),
});

/** 路径一律先按 cwd 解成绝对路径；写命令到 workspace 的相对换算在 `run.ts`（那里能取真实路径）。 */
const absoluteOf = (file: string, cwd: string): string => resolve(cwd, file);

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
          ? "patch 缺少 <nodeId>"
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
        : unusedFlag(raw, ["--json", "--port", "--workspace", "--allow-host", "--app-dir"]);
  if (message !== undefined) return failure(message, "serve");
  const port = portOf(raw);
  if (port === "invalid") return failure(`--port 必须是 0..${String(MAX_PORT)} 的整数`, "serve");
  const appDirRaw = raw.values.get("--app-dir");
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
      ...commonOf(raw, cwd),
    },
  };
};

const topicOf = (positionals: readonly string[]): CommandName | undefined => {
  const [first] = positionals;
  return isCommandName(first) ? first : undefined;
};

const build = (raw: Raw, cwd: string): ParsedArgs => {
  const [name, ...rest] = raw.positionals;
  if (name === undefined) {
    return failure("缺少命令：outline | read | patch | style | serve", undefined);
  }
  if (!isCommandName(name)) {
    return failure(`未知命令：${name}`, undefined);
  }
  if (name === "outline") return outlineIntent(raw, rest, cwd);
  if (name === "read") return readIntent(raw, rest, cwd);
  if (name === "patch") return patchIntent(raw, rest, cwd);
  if (name === "serve") return serveIntent(raw, rest, cwd);
  return styleIntent(raw, rest, cwd);
};

export const parseArgs = (argv: readonly string[], cwd: string): ParsedArgs => {
  const tokenized = tokenize(argv);
  if (!tokenized.ok) return failure(tokenized.message, undefined);
  if (tokenized.raw.switches.has("--help")) {
    return { ok: true, intent: { kind: "help", topic: topicOf(tokenized.raw.positionals) } };
  }
  return build(tokenized.raw, cwd);
};
