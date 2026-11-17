// 这层管：`hr png` 的 argv 切片 → intent（长图尺寸三参数 / 超时 / 落盘位置）；不读盘、不开 Chrome。
// 尺寸只透传原文（`--page-size` 同一口径）：合法区间属于语义，退出码是 1 而不是 2。
// 与 `args-pdf.ts` 同一套写法：位置参数一个文件、`--out` 必填、其它 flag 出现即报未用。
// 例外是 `--outline`/`--no-outline`：本子命令不支持，但它们是**已知**旗标，放行到意图里由命令层报 `invalid_input`。

import { absoluteOf, commonOf, failure, unusedFlag, type ParsedArgs } from "./intent";
import type { Raw } from "./tokens";

const PNG_FLAGS = [
  "--force",
  "--json",
  "--max-height",
  "--no-outline",
  "--out",
  "--outline",
  "--scale",
  "--timeout",
  "--width",
  "--workspace",
];

interface Range {
  readonly flag: string;
  readonly fallback: number;
  readonly min: number;
  readonly max: number;
}

const TIMEOUT: Range = { flag: "--timeout", fallback: 60, min: 1, max: 600 };

const DEFAULT_WIDTH = "1200";

const DEFAULT_SCALE = "2";

const DEFAULT_MAX_HEIGHT = "20000";

const OUTLINE_FLAGS: readonly string[] = ["--outline", "--no-outline"];

/** 大纲旗标在 png 上是“已知旗标放错子命令”：放行到意图里，由命令层报 `invalid_input` exit 1。 */
const outlineFlagOf = (raw: Raw): string | undefined =>
  OUTLINE_FLAGS.find((flag) => raw.switches.has(flag));

/** 越界不夹紧、不四舍五入：解析不出整数就整条拒绝，错误文案里带合法区间。 */
const numberOf = (raw: Raw, range: Range): number | "invalid" => {
  const value = raw.values.get(range.flag);
  if (value === undefined) return range.fallback;
  const parsed = Number(value);
  const legal = Number.isInteger(parsed) && parsed >= range.min && parsed <= range.max;
  return legal ? parsed : "invalid";
};

const outOfRange = (range: Range): ParsedArgs =>
  failure(`${range.flag} 必须是 ${String(range.min)}..${String(range.max)} 的整数`, "png");

/** 位置参数与开关的先后顺序就是报错优先级：多给位置参数时先骂这个，再骂缺文件。 */
const problemOf = (raw: Raw, rest: readonly string[]): string | undefined => {
  const [file = "", ...extra] = rest;
  if (extra.length > 0) return `png 只接受 1 个位置参数，多出 ${String(extra.length)} 个`;
  if (file === "") return "png 缺少 <file>";
  return unusedFlag(raw, PNG_FLAGS);
};

export const pngIntent = (raw: Raw, rest: readonly string[], cwd: string): ParsedArgs => {
  const [file = ""] = rest;
  const out = raw.values.get("--out");
  const message = problemOf(raw, rest);
  if (message !== undefined) return failure(message, "png");
  if (out === undefined || out === "") return failure("png 缺少 --out <path>", "png");
  const timeoutSec = numberOf(raw, TIMEOUT);
  if (timeoutSec === "invalid") return outOfRange(TIMEOUT);
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
      // 裸布尔而不是 `undefined` 哨兵：命令层只关心“用户到底给没给”，默认值的来源不参与判断。
      maxHeightExplicit: raw.values.has("--max-height"),
      outlineFlag: outlineFlagOf(raw),
      timeoutMs: timeoutSec * 1000,
      force: raw.switches.has("--force"),
      ...commonOf(raw, cwd),
    },
  };
};
