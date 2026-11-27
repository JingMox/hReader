// This layer: argument validation and intent construction for `hr annotations <list|migrate>`; no fs.

import type { AnnotationStatusFilter } from "@hreader/core";

import { absoluteOf, commonOf, failure, unusedFlag, type ParsedArgs } from "./intent";
import type { Raw } from "./raw";

const LIST_FLAGS = ["--json", "--status", "--workspace"];
const MIGRATE_FLAGS = ["--json", "--workspace"];

const STATUSES = ["pending", "resolved", "all"] as const;

/** `--status` either parses into a real filter or is a usage problem — never both, so no dead arm survives validation. */
const statusOf = (
  raw: Raw,
): { readonly status: AnnotationStatusFilter; readonly problem?: string } => {
  const value = raw.values.get("--status");
  if (value === undefined) return { status: "all" };
  return (STATUSES as readonly string[]).includes(value)
    ? { status: value as AnnotationStatusFilter }
    : { status: "all", problem: `--status 必须是 ${STATUSES.join(" | ")} 之一` };
};

const listIntent = (raw: Raw, rest: readonly string[], cwd: string): ParsedArgs => {
  const [file = "", ...extra] = rest;
  const { status, problem: statusProblem } = statusOf(raw);
  const problem =
    extra.length > 0
      ? `list 只接受 1 个位置参数，多出 ${String(extra.length)} 个`
      : file === ""
        ? "list 缺少 <file>"
        : (statusProblem ?? unusedFlag(raw, LIST_FLAGS));
  if (problem !== undefined) return failure(problem, "annotations");
  return {
    ok: true,
    intent: {
      kind: "annotationsList",
      path: absoluteOf(file, cwd),
      status,
      ...commonOf(raw, cwd),
    },
  };
};

const migrateIntent = (raw: Raw, rest: readonly string[], cwd: string): ParsedArgs => {
  const [file = "", ...extra] = rest;
  const problem =
    extra.length > 0
      ? `migrate 只接受 1 个位置参数，多出 ${String(extra.length)} 个`
      : file === ""
        ? "migrate 缺少 <file>"
        : unusedFlag(raw, MIGRATE_FLAGS);
  if (problem !== undefined) return failure(problem, "annotations");
  return {
    ok: true,
    intent: {
      kind: "annotationsMigrate",
      path: absoluteOf(file, cwd),
      ...commonOf(raw, cwd),
    },
  };
};

export const annotationsIntent = (raw: Raw, rest: readonly string[], cwd: string): ParsedArgs => {
  const [sub = "", ...subrest] = rest;
  switch (sub) {
    case "list":
      return listIntent(raw, subrest, cwd);
    case "migrate":
      return migrateIntent(raw, subrest, cwd);
    case "":
      return failure("annotations 缺少子命令：list | migrate", "annotations");
    default:
      return failure(`未知的 annotations 子命令：${sub}（可选：list | migrate）`, "annotations");
  }
};
