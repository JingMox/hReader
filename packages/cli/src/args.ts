// 这层管：argv → 意图的纯函数（不读 process、不做 IO、不抛异常）；错误用联合返回。
// CLI 层的用法错误（exit 2）全部在这里产生，core 的 `HrError` 在命令层才可能出现。

import { relative, resolve } from "node:path";

import type { PatchAction } from "@hreader/core";

import { tokenize, type Raw } from "./tokens";
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
  | ({ readonly kind: "style"; readonly path: string; readonly mode: StyleMode } & Common);

export type ParsedArgs =
  | { readonly ok: true; readonly intent: Intent }
  | {
      readonly ok: false;
      readonly message: string;
      readonly topic: CommandName | undefined;
      readonly json: boolean;
    };

const MAX_BYTES_CEILING = 10_000_000;

const ACTIONS: readonly string[] = ["replace", "insert_before", "insert_after", "append", "delete"];

const isAction = (value: string): value is PatchAction => ACTIONS.includes(value);

const failure = (message: string, topic: CommandName | undefined, json: boolean): ParsedArgs => ({
  ok: false,
  message,
  topic,
  json,
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

/** 只读命令：按 cwd 直接解析成绝对路径（卡片 §1：outline/read 不校验 workspace）。 */
const readPathOf = (file: string, cwd: string): string => resolve(cwd, file);

/** 写命令：core 只接受 workspace 内的相对路径，`../x` 这类越界串原样下传，由 core 判 `path_outside_workspace`。 */
const targetOf = (file: string, cwd: string, workspace: string): string =>
  relative(workspace, resolve(cwd, file));

const outlineIntent = (raw: Raw, rest: readonly string[], cwd: string): ParsedArgs => {
  const [file = "", ...extra] = rest;
  const problem =
    extra.length > 0
      ? `outline 只接受 1 个位置参数，多出 ${String(extra.length)} 个`
      : file === ""
        ? "outline 缺少 <file>"
        : unusedFlag(raw, ["--json", "--workspace"]);
  if (problem !== undefined) return failure(problem, "outline", raw.switches.has("--json"));
  return {
    ok: true,
    intent: { kind: "outline", path: readPathOf(file, cwd), ...commonOf(raw, cwd) },
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
  if (message !== undefined) return failure(message, "read", raw.switches.has("--json"));
  const maxBytes = maxBytesOf(raw);
  if (maxBytes === "invalid") {
    return failure(
      `--max-bytes 必须是 1..${String(MAX_BYTES_CEILING)} 的整数`,
      "read",
      raw.switches.has("--json"),
    );
  }
  return {
    ok: true,
    intent: { kind: "read", path: readPathOf(file, cwd), target, maxBytes, ...commonOf(raw, cwd) },
  };
};

type SourceResult =
  | { readonly ok: true; readonly source: HtmlSource | undefined }
  | { readonly ok: false; readonly message: string };

const sourceOf = (raw: Raw, action: PatchAction): SourceResult => {
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
  if (file !== undefined) return { ok: true, source: { kind: "file", path: file } };
  return { ok: true, source: { kind: "stdin" } };
};

const patchIntent = (raw: Raw, rest: readonly string[], cwd: string): ParsedArgs => {
  const json = raw.switches.has("--json");
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
  if (message !== undefined) return failure(message, "patch", json);
  const action = raw.values.get("--action");
  if (action === undefined) return failure("patch 缺少 --action", "patch", json);
  if (!isAction(action)) return failure(`未知的 --action：${action}`, "patch", json);
  const source = sourceOf(raw, action);
  if (!source.ok) return failure(source.message, "patch", json);
  const common = commonOf(raw, cwd);
  return {
    ok: true,
    intent: {
      kind: "patch",
      path: targetOf(file, cwd, common.workspace),
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
  const json = raw.switches.has("--json");
  const [file = "", ...extra] = rest;
  const message =
    extra.length > 0
      ? `style 只接受 1 个位置参数，多出 ${String(extra.length)} 个`
      : file === ""
        ? "style 缺少 <file>"
        : unusedFlag(raw, ["--json", "--lint", "--tone", "--visual", "--workspace"]);
  if (message !== undefined) return failure(message, "style", json);
  const mode = modeOf(raw);
  if (mode === undefined)
    return failure("style 需要 --visual <id> / --tone <id> / --lint 之一", "style", json);
  if (mode === "invalid")
    return failure("--visual / --tone / --lint 必须且只能给一个", "style", json);
  const common = commonOf(raw, cwd);
  return {
    ok: true,
    intent: { kind: "style", path: targetOf(file, cwd, common.workspace), mode, ...common },
  };
};

const topicOf = (positionals: readonly string[]): CommandName | undefined => {
  const [first] = positionals;
  return isCommandName(first) ? first : undefined;
};

const build = (raw: Raw, cwd: string): ParsedArgs => {
  const [name, ...rest] = raw.positionals;
  if (name === undefined) {
    return failure(
      "缺少命令：outline | read | patch | style",
      undefined,
      raw.switches.has("--json"),
    );
  }
  if (!isCommandName(name)) {
    return failure(`未知命令：${name}`, undefined, raw.switches.has("--json"));
  }
  if (name === "outline") return outlineIntent(raw, rest, cwd);
  if (name === "read") return readIntent(raw, rest, cwd);
  if (name === "patch") return patchIntent(raw, rest, cwd);
  return styleIntent(raw, rest, cwd);
};

export const parseArgs = (argv: readonly string[], cwd: string): ParsedArgs => {
  const tokenized = tokenize(argv);
  if (!tokenized.ok) return failure(tokenized.message, undefined, tokenized.json);
  if (tokenized.raw.switches.has("--help")) {
    return { ok: true, intent: { kind: "help", topic: topicOf(tokenized.raw.positionals) } };
  }
  return build(tokenized.raw, cwd);
};
