// This layer: argv slicing for `hr export` / `hr pdf` / `hr png` -> intent; never reads disk or starts Chrome.

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

const THUMB_FLAGS = ["--force", "--json", "--out", "--timeout", "--visual", "--workspace"];

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
      // The default theme is decided here; `--visual` values are validated in core.
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
  // Mutual exclusion is not an error here: each flag is legal on its own; giving both is a semantic problem (`invalid_input` exit 1) for the command layer.
  return {
    ok: true,
    intent: {
      kind: "pdf",
      path: absoluteOf(file, cwd),
      pageSize: raw.values.get("--page-size") ?? DEFAULT_PAGE_SIZE,
      timeoutMs: timeoutSec * 1000,
      outline: !raw.switches.has("--no-outline"),
      outlineConflict: raw.switches.has("--outline") && raw.switches.has("--no-outline"),
      // A missing `--visual` follows the fallback chain "embedded document theme -> default theme" rather than being fixed at the usage layer;
      // explicit values are validated in core (`unknown_style`), same as `hr export`.
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
      // The three size defaults only apply here; range checking is the command layer's job (out of range is `invalid_input` exit 1, not usage error exit 2).
      width: raw.values.get("--width") ?? DEFAULT_WIDTH,
      scale: raw.values.get("--scale") ?? DEFAULT_SCALE,
      maxHeight: raw.values.get("--max-height") ?? DEFAULT_MAX_HEIGHT,
      maxHeightExplicit: raw.values.has("--max-height"),
      // `--outline`/`--no-outline` on png are "known flags on the wrong subcommand": pass them into the intent and let the command layer report `invalid_input`.
      outlineFlag: OUTLINE_FLAGS.find((flag) => raw.switches.has(flag)),
      timeoutMs: timeoutSec * 1000,
      // The default likewise leaves theme selection to the command layer (embedded document theme -> default theme).
      visual: raw.values.get("--visual"),
      force: raw.switches.has("--force"),
      ...commonOf(raw, cwd),
    },
  };
};

const thumbProblemOf = (raw: Raw, rest: readonly string[]): string | undefined => {
  const [file = "", ...extra] = rest;
  if (extra.length > 0) return `thumb 只接受 1 个位置参数，多出 ${String(extra.length)} 个`;
  if (file === "") return "thumb 缺少 <file>";
  if (raw.values.get("--visual") === "") return "--visual 不能为空";
  return unusedFlag(raw, THUMB_FLAGS);
};

export const thumbIntent = (raw: Raw, rest: readonly string[], cwd: string): ParsedArgs => {
  const [file = ""] = rest;
  const message = thumbProblemOf(raw, rest);
  if (message !== undefined) return failure(message, "thumb");
  const out = raw.values.get("--out");
  const timeoutSec = timeoutOf(raw);
  if (timeoutSec === "invalid") {
    return failure(`--timeout 必须是 1..${String(MAX_TIMEOUT_S)} 的整数`, "thumb");
  }
  return {
    ok: true,
    intent: {
      kind: "thumb",
      path: absoluteOf(file, cwd),
      // `--out` stays optional: unset means "PNG to stdout" — `hr export` uses the same empty-string-as-unset rule.
      out: out === undefined || out === "" ? undefined : absoluteOf(out, cwd),
      timeoutMs: timeoutSec * 1000,
      // The default leaves theme selection to the command layer (embedded document theme -> default theme), same as `hr png`.
      visual: raw.values.get("--visual"),
      force: raw.switches.has("--force"),
      ...commonOf(raw, cwd),
    },
  };
};
