// 这层管：`hr export` / `hr pdf` / `hr png` 的 argv 切片 → intent；不读盘、不开 Chrome。

import { DEFAULT_STYLE_ID } from "@hreader/core";

import { absoluteOf, commonOf, failure, intInRange, unusedFlag, type ParsedArgs } from "./intent";
import type { Raw } from "./raw";

const EXPORT_FLAGS = ["--force", "--json", "--out", "--visual", "--workspace"];

const PDF_FLAGS = [
  "--force",
  "--json",
  "--no-outline",
  "--out",
  "--outline",
  "--page-size",
  "--timeout",
  "--visual",
  "--workspace",
];

const PNG_FLAGS = [
  "--force",
  "--json",
  "--max-height",
  "--no-outline",
  "--out",
  "--outline",
  "--scale",
  "--timeout",
  "--visual",
  "--width",
  "--workspace",
];

const DEFAULT_PAGE_SIZE = "a4";
const DEFAULT_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 600;
const DEFAULT_WIDTH = "1200";
const DEFAULT_SCALE = "2";
const DEFAULT_MAX_HEIGHT = "20000";
const OUTLINE_FLAGS: readonly string[] = ["--outline", "--no-outline"];

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
      // 缺省主题由这里定：`--visual` 的合法值校验在 core。
      visual: visual ?? DEFAULT_STYLE_ID,
      out: out === undefined || out === "" ? undefined : absoluteOf(out, cwd),
      force: raw.switches.has("--force"),
      ...commonOf(raw, cwd),
    },
  };
};

const timeoutOf = (raw: Raw): number | "invalid" =>
  intInRange(raw, "--timeout", 1, MAX_TIMEOUT_S) ?? DEFAULT_TIMEOUT_S;

export const pdfIntent = (raw: Raw, rest: readonly string[], cwd: string): ParsedArgs => {
  const [file = "", ...extra] = rest;
  const out = raw.values.get("--out");
  const visual = raw.values.get("--visual");
  const message =
    extra.length > 0
      ? `pdf 只接受 1 个位置参数，多出 ${String(extra.length)} 个`
      : file === ""
        ? "pdf 缺少 <file>"
        : visual === ""
          ? "--visual 不能为空"
          : unusedFlag(raw, PDF_FLAGS);
  if (message !== undefined) return failure(message, "pdf");
  if (out === undefined || out === "") return failure("pdf 缺少 --out <path>", "pdf");
  const timeoutSec = timeoutOf(raw);
  if (timeoutSec === "invalid") {
    return failure(`--timeout 必须是 1..${String(MAX_TIMEOUT_S)} 的整数秒`, "pdf");
  }
  // 互斥不在这里报错：两个旗标各自合法，"同时给"是语义问题（`invalid_input` exit 1），归命令层判。
  return {
    ok: true,
    intent: {
      kind: "pdf",
      path: absoluteOf(file, cwd),
      pageSize: raw.values.get("--page-size") ?? DEFAULT_PAGE_SIZE,
      timeoutMs: timeoutSec * 1000,
      outline: !raw.switches.has("--no-outline"),
      outlineConflict: raw.switches.has("--outline") && raw.switches.has("--no-outline"),
      // `--visual` 缺省走"文档已嵌入主题 → 默认主题"的回落链，不在用法层焊死；
      // 显式值的合法值校验在 core（`unknown_style`），与 `hr export` 同口径。
      visual,
      out: absoluteOf(out, cwd),
      force: raw.switches.has("--force"),
      ...commonOf(raw, cwd),
    },
  };
};

const pngProblemOf = (raw: Raw, rest: readonly string[]): string | undefined => {
  const [file = "", ...extra] = rest;
  if (extra.length > 0) return `png 只接受 1 个位置参数，多出 ${String(extra.length)} 个`;
  if (file === "") return "png 缺少 <file>";
  if (raw.values.get("--visual") === "") return "--visual 不能为空";
  return unusedFlag(raw, PNG_FLAGS);
};

export const pngIntent = (raw: Raw, rest: readonly string[], cwd: string): ParsedArgs => {
  const [file = ""] = rest;
  const out = raw.values.get("--out");
  const message = pngProblemOf(raw, rest);
  if (message !== undefined) return failure(message, "png");
  if (out === undefined || out === "") return failure("png 缺少 --out <path>", "png");
  const timeoutSec = timeoutOf(raw);
  if (timeoutSec === "invalid") {
    return failure(`--timeout 必须是 1..${String(MAX_TIMEOUT_S)} 的整数`, "png");
  }
  return {
    ok: true,
    intent: {
      kind: "png",
      path: absoluteOf(file, cwd),
      out: absoluteOf(out, cwd),
      // 三个尺寸只在这里取默认值；区间由命令层判（越界是 `invalid_input` exit 1，不是用法错误 exit 2）。
      width: raw.values.get("--width") ?? DEFAULT_WIDTH,
      scale: raw.values.get("--scale") ?? DEFAULT_SCALE,
      maxHeight: raw.values.get("--max-height") ?? DEFAULT_MAX_HEIGHT,
      maxHeightExplicit: raw.values.has("--max-height"),
      // `--outline`/`--no-outline` 在 png 上是"已知旗标放错子命令"：放行到意图里，由命令层报 `invalid_input`。
      outlineFlag: OUTLINE_FLAGS.find((flag) => raw.switches.has(flag)),
      timeoutMs: timeoutSec * 1000,
      // 缺省同样把主题选择权交给命令层（文档嵌入主题 → 默认主题）。
      visual: raw.values.get("--visual"),
      force: raw.switches.has("--force"),
      ...commonOf(raw, cwd),
    },
  };
};
