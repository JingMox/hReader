// 这层管：D10 的手工烟测门——扩展的 Pi 类型是手抄的窄接口（本仓没有编译器盯着它），
// 唯一的真验证是让真 `pi` 加载这个文件一次。**不进 CI**（需要本机装 pi、要起真进程）。
// 用法：`pnpm smoke:pi`。
//
// 判定全部落在可复现的信号上，不看模型措辞：
//   1. 本机 pi 版本 == 抄签名时的版本（漂了就该重抄 `pi-hreader.ts` 头部那四段）；
//   2. 加载不报 `Failed to load extension`——这条同时覆盖注册期校验：Pi 的 `registerCommand`
//      会检查 name 非空 + handler 是函数，`registerTool` 会检查 `parameters` 是对象 schema，
//      任一处签名抄错都会在加载时炸成这条错误；
//   3. `/hreader` 与 `/hr-style` 被当成**命令**处理：print 模式下无 UI，处理器静默结束 → 空输出 + 退出 0；
//   4. 对照组：不加载扩展时同一个 `/hreader` 会被当成提示词送进模型 → 输出非空。

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** 抄 `ExtensionAPI`/`ExtensionContext` 等签名时的版本（见 `pi-hreader.ts` 头部注释）。 */
const SIGNATURE_PI_VERSION = "1.5.2";
const EXTENSION = fileURLToPath(new URL("../packages/pi-extension/pi-hreader.ts", import.meta.url));
const TIMEOUT_MS = 120_000;
const LOAD_FAILURE = "Failed to load extension";

interface Run {
  readonly status: number | null;
  readonly output: string;
}

/** 在空目录里跑：仓库的 AGENTS.md、技能、模板都会影响提示词路径，对照组就不干净了。 */
const SANDBOX = mkdtempSync(join(tmpdir(), "hreader-smoke-"));

const runPi = (args: readonly string[]): Run => {
  const result = spawnSync("pi", args, { cwd: SANDBOX, encoding: "utf8", timeout: TIMEOUT_MS });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
};

/** json 模式每行一个事件；只关心 `type` 字段。 */
const eventTypesOf = (output: string): readonly string[] =>
  output
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed === "object" && parsed !== null && "type" in parsed) {
          const type: unknown = parsed.type;
          return typeof type === "string" ? [type] : [];
        }
        return [];
      } catch {
        return [];
      }
    });

const failures: string[] = [];
const check = (passed: boolean, label: string, detail: string): void => {
  process.stdout.write(`${passed ? "✓" : "✗"} ${label}\n`);
  if (!passed) failures.push(`${label}——${detail.trim().slice(0, 400)}`);
};

const BASE = [
  "--offline",
  "--no-session",
  "--no-extensions",
  "--no-context-files",
  "--no-skills",
  "--no-prompt-templates",
  "--mode",
  "json",
];

const version = runPi(["--version"]).output.trim();
check(
  version === SIGNATURE_PI_VERSION,
  `pi 版本是抄签名时的 ${SIGNATURE_PI_VERSION}`,
  `实测 ${version}：比对 pi-hreader.ts 头部四段签名后再改这个常量`,
);

const loaded = runPi([...BASE, "--extension", EXTENSION, "--print", "/hreader"]);
check(
  !loaded.output.includes(LOAD_FAILURE),
  "扩展加载通过 Pi 的注册期校验（命令名/handler、工具 parameters）",
  loaded.output,
);
const loadedTypes = eventTypesOf(loaded.output);
check(
  loaded.status === 0 && loadedTypes.length > 0 && loadedTypes.every((type) => type === "session"),
  "`/hreader` 作为命令被执行（print 模式无 UI → 只有 session 事件，没有模型回合）",
  `退出码 ${String(loaded.status)}；事件：${loadedTypes.join(",") || "无"}；输出：${loaded.output}`,
);

const control = runPi([...BASE, "--print", "/hreader"]);
const controlTypes = eventTypesOf(control.output);
check(
  controlTypes.some((type) => type !== "session"),
  "对照组：不加载扩展时 `/hreader` 落到模型（出现模型回合事件，不是恒真断言）",
  `退出码 ${String(control.status)}；事件：${controlTypes.join(",") || "无"}；输出：${control.output}`,
);

// AC-5 也要一条真加载的证据：`/hr-style` 同样必须是**命令**（print 模式下静默结束，不进模型回合）。
const styled = runPi([...BASE, "--extension", EXTENSION, "--print", "/hr-style"]);
const styledTypes = eventTypesOf(styled.output);
check(
  styled.status === 0 && styledTypes.length > 0 && styledTypes.every((type) => type === "session"),
  "`/hr-style` 也作为命令被执行（注册面含两条命令，不是只认 `/hreader`）",
  `退出码 ${String(styled.status)}；事件：${styledTypes.join(",") || "无"}；输出：${styled.output}`,
);

if (failures.length > 0) {
  process.stderr.write(`\n烟测失败 ${String(failures.length)} 条：\n${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("\n烟测通过：真 pi 能加载本扩展并执行 `/hreader` 与 `/hr-style`。\n");
}
