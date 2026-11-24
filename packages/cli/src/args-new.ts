// 这层管：`hr new` 的 argv 切片 → intent（落点 + 文档形态 + 标题 + 主题）；不读盘、不生成文档。

import { basename, extname } from "node:path";

import { DEFAULT_DOC_KIND, DEFAULT_STYLE_ID, DOC_KINDS, isDocKind } from "@hreader/core";

import { absoluteOf, commonOf, failure, unusedFlag, type ParsedArgs } from "./intent";
import type { Raw } from "./tokens";

const NEW_FLAGS = ["--force", "--json", "--kind", "--title", "--visual", "--workspace"];

const shapeProblemOf = (raw: Raw, rest: readonly string[]): string | undefined => {
  const [file = "", ...extra] = rest;
  if (extra.length > 0) return `new 只接受 1 个位置参数，多出 ${String(extra.length)} 个`;
  if (file === "") return "new 缺少 <file>";
  if (raw.values.get("--title") === "") return "--title 不能为空";
  return unusedFlag(raw, NEW_FLAGS);
};

export const newIntent = (raw: Raw, rest: readonly string[], cwd: string): ParsedArgs => {
  const problem = shapeProblemOf(raw, rest);
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
