// This layer: argument validation and intent construction for `hr template <list|show|new|save>`; no fs.

import { absoluteOf, commonOf, failure, homeOf, unusedFlag, type ParsedArgs } from "./intent";
import type { Raw } from "./raw";

const HOME_JSON_FLAGS = ["--home", "--json", "--workspace"];

const TEMPLATE_LIST_FLAGS = HOME_JSON_FLAGS;
const TEMPLATE_SHOW_FLAGS = HOME_JSON_FLAGS;
const TEMPLATE_NEW_FLAGS = [...HOME_JSON_FLAGS, "--template", "--title"];
const TEMPLATE_SAVE_FLAGS = [...HOME_JSON_FLAGS, "--description", "--global", "--id", "--name"];

const listIntent = (raw: Raw, rest: readonly string[], cwd: string): ParsedArgs => {
  const problem =
    rest.length > 0
      ? `list 不接受位置参数，多出 ${String(rest.length)} 个`
      : unusedFlag(raw, TEMPLATE_LIST_FLAGS);
  if (problem !== undefined) return failure(problem, "template");
  return { ok: true, intent: { kind: "templateList", ...homeOf(raw, cwd), ...commonOf(raw, cwd) } };
};

const showIntent = (raw: Raw, rest: readonly string[], cwd: string): ParsedArgs => {
  const [id = "", ...extra] = rest;
  const problem =
    extra.length > 0
      ? `show 只接受 1 个位置参数，多出 ${String(extra.length)} 个`
      : id === ""
        ? "show 缺少 <id>"
        : unusedFlag(raw, TEMPLATE_SHOW_FLAGS);
  if (problem !== undefined) return failure(problem, "template");
  return {
    ok: true,
    intent: { kind: "templateShow", id, ...homeOf(raw, cwd), ...commonOf(raw, cwd) },
  };
};

const newFromTemplateIntent = (raw: Raw, rest: readonly string[], cwd: string): ParsedArgs => {
  const [file = "", ...extra] = rest;
  const problem =
    extra.length > 0
      ? `new 只接受 1 个位置参数，多出 ${String(extra.length)} 个`
      : file === ""
        ? "new 缺少 <file>"
        : raw.values.get("--template") === ""
          ? "--template 不能为空"
          : raw.values.get("--title") === ""
            ? "--title 不能为空"
            : unusedFlag(raw, TEMPLATE_NEW_FLAGS);
  if (problem !== undefined) return failure(problem, "template");
  const template = raw.values.get("--template");
  if (template === undefined) return failure("new 缺少 --template <id>", "template");
  return {
    ok: true,
    intent: {
      kind: "templateNew",
      path: absoluteOf(file, cwd),
      template,
      title: raw.values.get("--title"),
      ...homeOf(raw, cwd),
      ...commonOf(raw, cwd),
    },
  };
};

const saveIntent = (raw: Raw, rest: readonly string[], cwd: string): ParsedArgs => {
  const [file = "", ...extra] = rest;
  const problem =
    extra.length > 0
      ? `save 只接受 1 个位置参数，多出 ${String(extra.length)} 个`
      : file === ""
        ? "save 缺少 <file>"
        : raw.values.get("--id") === ""
          ? "--id 不能为空"
          : raw.values.get("--name") === ""
            ? "--name 不能为空"
            : raw.values.get("--description") === ""
              ? "--description 不能为空"
              : unusedFlag(raw, TEMPLATE_SAVE_FLAGS);
  if (problem !== undefined) return failure(problem, "template");
  const id = raw.values.get("--id");
  if (id === undefined) return failure("save 缺少 --id <id>", "template");
  return {
    ok: true,
    intent: {
      kind: "templateSave",
      path: absoluteOf(file, cwd),
      id,
      global: raw.switches.has("--global"),
      name: raw.values.get("--name"),
      description: raw.values.get("--description"),
      ...homeOf(raw, cwd),
      ...commonOf(raw, cwd),
    },
  };
};

/** `--template` on `hr new` is an alias for `hr template new`: it cannot mix with shape/theme flags that only the skeleton path understands. */
export const templateConflictOf = (raw: Raw): string | undefined =>
  raw.switches.has("--force") ||
  raw.values.get("--kind") !== undefined ||
  raw.values.get("--visual") !== undefined
    ? "--template 不能与 --kind / --visual / --force 同用"
    : undefined;

export const templateIntent = (raw: Raw, rest: readonly string[], cwd: string): ParsedArgs => {
  const [sub = "", ...subrest] = rest;
  switch (sub) {
    case "list":
      return listIntent(raw, subrest, cwd);
    case "show":
      return showIntent(raw, subrest, cwd);
    case "new":
      return newFromTemplateIntent(raw, subrest, cwd);
    case "save":
      return saveIntent(raw, subrest, cwd);
    case "":
      return failure("template 缺少子命令：list | show | new | save", "template");
    default:
      return failure(
        `未知的 template 子命令：${sub}（可选：list | show | new | save）`,
        "template",
      );
  }
};
