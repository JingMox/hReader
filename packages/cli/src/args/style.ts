// 这层管：`hr style` 与 `hr style extract` 的 argv 切片 → intent；不读盘、不判风格是否存在。

import { basename, extname } from "node:path";

import { DEFAULT_STYLE_ID } from "@hreader/core";

import {
  absoluteOf,
  commonOf,
  failure,
  strictOf,
  unusedFlag,
  type ParsedArgs,
  type StyleMode,
} from "./intent";
import type { Raw } from "./raw";

const EXTRACT_FLAGS = [
  "--base-url",
  "--force",
  "--id",
  "--inherits-visual",
  "--json",
  "--model",
  "--name",
  "--no-llm",
  "--out",
  "--workspace",
];

/** 文件名 → 风格 id：只留小写字母数字与连字符；中文文件名常见，空结果回落 `style`。 */
const slugOf = (path: string): string => {
  const slug = basename(path, extname(path))
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return slug === "" ? "style" : slug;
};

/** `--id` 的合法性留给 `parseStyleText`（一处正则、一处报错口径），这里只负责默认值。 */
const extractIntent = (raw: Raw, rest: readonly string[], cwd: string): ParsedArgs => {
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
      model: raw.values.get("--model"),
      baseUrl: raw.values.get("--base-url"),
      force: raw.switches.has("--force"),
      ...commonOf(raw, cwd),
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

export const styleIntent = (raw: Raw, rest: readonly string[], cwd: string): ParsedArgs => {
  if (rest[0] === "extract") return extractIntent(raw, rest.slice(1), cwd);
  const [file = "", ...extra] = rest;
  const message =
    extra.length > 0
      ? `style 只接受 1 个位置参数，多出 ${String(extra.length)} 个`
      : file === ""
        ? "style 缺少 <file>"
        : unusedFlag(raw, ["--json", "--lint", "--strict", "--tone", "--visual", "--workspace"]);
  if (message !== undefined) return failure(message, "style");
  const mode = modeOf(raw);
  if (mode === undefined)
    return failure("style 需要 --visual <id> / --tone <id> / --lint 之一", "style");
  if (mode === "invalid") return failure("--visual / --tone / --lint 必须且只能给一个", "style");
  const strict = strictOf(raw);
  if (strict === "invalid") {
    return failure(
      `未知的 --strict：${String(raw.values.get("--strict"))}（可选：error | warning）`,
      "style",
    );
  }
  if (strict !== undefined && mode.kind !== "lint") {
    return failure("--strict 只与 --lint 同用", "style");
  }
  const common = commonOf(raw, cwd);
  return {
    ok: true,
    intent: { kind: "style", path: absoluteOf(file, cwd), mode, strict, ...common },
  };
};
