// 这层管：`hr export` 的 argv 切片 → intent（文档 + 视觉主题 + 落盘位置）；不读盘、不判大小。

import { DEFAULT_STYLE_ID } from "@hreader/core";

import { absoluteOf, commonOf, failure, unusedFlag, type ParsedArgs } from "./intent";
import type { Raw } from "./tokens";

const EXPORT_FLAGS = ["--force", "--json", "--out", "--visual", "--workspace"];

export const exportIntent = (raw: Raw, rest: readonly string[], cwd: string): ParsedArgs => {
  const [file = "", ...extra] = rest;
  const out = raw.values.get("--out");
  const visual = raw.values.get("--visual");
  const message =
    extra.length > 0
      ? `export 只接受 1 个位置参数，多出 ${String(extra.length)} 个`
      : file === ""
        ? "export 缺少 <file>"
        : visual === ""
          ? "--visual 不能为空"
          : unusedFlag(raw, EXPORT_FLAGS);
  if (message !== undefined) return failure(message, "export");
  return {
    ok: true,
    intent: {
      kind: "export",
      path: absoluteOf(file, cwd),
      // 缺省主题由这里定：`--visual` 的合法值校验在 core（`assertStyleId` / `resolveThemePath`）。
      visual: visual ?? DEFAULT_STYLE_ID,
      out: out === undefined || out === "" ? undefined : absoluteOf(out, cwd),
      force: raw.switches.has("--force"),
      ...commonOf(raw, cwd),
    },
  };
};
