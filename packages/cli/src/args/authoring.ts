// 这层管：文档起稿、规范化、阅读、修补、检查与撤销命令的参数校验与 intent 构造；不碰 fs。

import { basename, extname } from "node:path";

import {
  DEFAULT_DOC_KIND,
  DEFAULT_STYLE_ID,
  DOC_KINDS,
  isDocKind,
  type PatchAction,
} from "@hreader/core";

import {
  absoluteOf,
  commonOf,
  failure,
  intInRange,
  unusedFlag,
  type HtmlSource,
  type ParsedArgs,
} from "./intent";
import type { Raw } from "./raw";

const MAX_BYTES_CEILING = 10_000_000;

const ACTIONS: readonly string[] = ["replace", "insert_before", "insert_after", "append", "delete"];

const NEW_FLAGS = ["--force", "--json", "--kind", "--title", "--visual", "--workspace"];

const isAction = (value: string): value is PatchAction => ACTIONS.includes(value);

const newShapeProblemOf = (raw: Raw, rest: readonly string[]): string | undefined => {
  const [file = "", ...extra] = rest;
  if (extra.length > 0) return `new 只接受 1 个位置参数，多出 ${String(extra.length)} 个`;
  if (file === "") return "new 缺少 <file>";
  if (raw.values.get("--title") === "") return "--title 不能为空";
  return unusedFlag(raw, NEW_FLAGS);
};

export const newIntent = (raw: Raw, rest: readonly string[], cwd: string): ParsedArgs => {
  const problem = newShapeProblemOf(raw, rest);
  if (problem !== undefined) return failure(problem, "new");
  const [file = ""] = rest;
  const docKind = raw.values.get("--kind") ?? DEFAULT_DOC_KIND;
  if (!isDocKind(docKind)) {
    return failure(`未知的 --kind：${docKind}（可选：${DOC_KINDS.join(" | ")}）`, "new");
  }
  return {
    ok: true,
    intent: {
      kind: "new",
      path: absoluteOf(file, cwd),
      docKind,
      // 标题缺省取文件名（去扩展名）：先有一份能看的稿，标题之后再 patch。
      title: raw.values.get("--title") ?? basename(file, extname(file)),
      // 缺省主题由这里定：合法性校验在 core（`loadThemeCss`）。
      visual: raw.values.get("--visual") ?? DEFAULT_STYLE_ID,
      force: raw.switches.has("--force"),
      ...commonOf(raw, cwd),
    },
  };
};

/** 只补 id、不碰其它字节：`--write` 才落盘，不给就只把结果打到 stdout。 */
export const normalizeIntent = (raw: Raw, rest: readonly string[], cwd: string): ParsedArgs => {
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

export const outlineIntent = (raw: Raw, rest: readonly string[], cwd: string): ParsedArgs => {
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

export const readIntent = (raw: Raw, rest: readonly string[], cwd: string): ParsedArgs => {
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
  const maxBytes = intInRange(raw, "--max-bytes", 1, MAX_BYTES_CEILING);
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

export const patchIntent = (raw: Raw, rest: readonly string[], cwd: string): ParsedArgs => {
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

export const plainIntent = (
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
