// 这层管：`hr pdf` 的 argv 切片 → intent（页面尺寸 / 超时 / 落盘位置）；不读盘、不开 Chrome。

import { absoluteOf, commonOf, failure, unusedFlag, type ParsedArgs } from "./intent";
import type { Raw } from "./tokens";

const PDF_FLAGS = ["--force", "--json", "--out", "--page-size", "--timeout", "--workspace"];

const DEFAULT_PAGE_SIZE = "a4";

const DEFAULT_TIMEOUT_S = 60;

const MAX_TIMEOUT_S = 600;

const timeoutOf = (raw: Raw): number | "invalid" => {
  const value = raw.values.get("--timeout");
  if (value === undefined) return DEFAULT_TIMEOUT_S;
  const parsed = Number(value);
  const legal = Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_TIMEOUT_S;
  return legal ? parsed : "invalid";
};

export const pdfIntent = (raw: Raw, rest: readonly string[], cwd: string): ParsedArgs => {
  const [file = "", ...extra] = rest;
  const out = raw.values.get("--out");
  const message =
    extra.length > 0
      ? `pdf 只接受 1 个位置参数，多出 ${String(extra.length)} 个`
      : file === ""
        ? "pdf 缺少 <file>"
        : unusedFlag(raw, PDF_FLAGS);
  if (message !== undefined) return failure(message, "pdf");
  if (out === undefined || out === "") return failure("pdf 缺少 --out <path>", "pdf");
  const timeoutSec = timeoutOf(raw);
  if (timeoutSec === "invalid") {
    return failure(`--timeout 必须是 1..${String(MAX_TIMEOUT_S)} 的整数秒`, "pdf");
  }
  return {
    ok: true,
    intent: {
      kind: "pdf",
      path: absoluteOf(file, cwd),
      pageSize: raw.values.get("--page-size") ?? DEFAULT_PAGE_SIZE,
      timeoutMs: timeoutSec * 1000,
      out: absoluteOf(out, cwd),
      force: raw.switches.has("--force"),
      ...commonOf(raw, cwd),
    },
  };
};
