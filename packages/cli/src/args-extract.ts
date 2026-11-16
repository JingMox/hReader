// 这层管：`hr style extract` 的 argv 切片 → intent（语料 + 风格元信息 + 写盘选项）；不读语料、不判大小。

import { basename, extname } from "node:path";

import { DEFAULT_STYLE_ID } from "@hreader/core";

import { absoluteOf, commonOf, failure, unusedFlag, type ParsedArgs } from "./intent";
import type { Raw } from "./tokens";

const EXTRACT_FLAGS = [
  "--force",
  "--id",
  "--inherits-visual",
  "--json",
  "--name",
  "--no-llm",
  "--out",
  "--workspace",
];

/** 文件名 → 风格 id：只留小写字母数字与连字符；中文文件名很常见，空结果回落 `style`（D10）。 */
const slugOf = (path: string): string => {
  const slug = basename(path, extname(path))
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return slug === "" ? "style" : slug;
};

/** `--id` 的合法性留给 `parseStyleText`（一处正则、一处报错口径），这里只负责默认值。 */
export const extractIntent = (raw: Raw, rest: readonly string[], cwd: string): ParsedArgs => {
  const first = rest[0];
  if (first === undefined)
    return failure("style extract 至少需要 1 篇语料（.md / .html）", "style");
  const problem = unusedFlag(raw, EXTRACT_FLAGS);
  if (problem !== undefined) return failure(problem, "style");
  const givenId = raw.values.get("--id");
  const givenName = raw.values.get("--name");
  const id = givenId ?? slugOf(first);
  const out = raw.values.get("--out");
  return {
    ok: true,
    intent: {
      kind: "styleExtract",
      files: rest.map((file) => absoluteOf(file, cwd)),
      id,
      name: givenName ?? id,
      idGiven: givenId !== undefined,
      nameGiven: givenName !== undefined,
      out: out === undefined ? undefined : absoluteOf(out, cwd),
      inheritsVisual: raw.values.get("--inherits-visual") ?? DEFAULT_STYLE_ID,
      noLlm: raw.switches.has("--no-llm"),
      force: raw.switches.has("--force"),
      ...commonOf(raw, cwd),
    },
  };
};
