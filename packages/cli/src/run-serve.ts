// 这层管：把 serve 意图装配成 `ServeInput`（别的命令的装配留在 `run.ts`）。
// 单独成文件只为职责边界：`run.ts` 只做分发，而 serve 是唯一要凑齐 `--app-dir` / `--allow-host` / 看门狗三项的命令。

import { existsSync } from "node:fs";

import { HrError } from "@hreader/core";

import type { Intent } from "./args";
import { serveCommand } from "./commands/serve";
import { displayedPathOf } from "./output";

/** 分发层已经归一好的三样东西：`--home` 的落点、停止口、以及"父 pid 只采集一次"的那次采集。 */
interface ServeWiring {
  /** `--home` 缺省时的落点（`run` 已把 `homedir()` 归到这里）。 */
  readonly home: string;
  /** 当前工作目录：报错里的路径按用户视角（相对 cwd）回显，与回执同一口径。缺省取进程 cwd。 */
  readonly cwd?: string | undefined;
  readonly stop: Promise<void>;
  /** 进程壳在首个 `await` 之前采集的父 pid；这里没有兜底——晚读 `process.ppid` 就是 B5/(W2) 那个洞。 */
  readonly launchParentPid: number;
  /** core 的诊断出口；不接上就等于把"`::` 上另有监听"与"清理陈旧 daemon.json"静默掉。 */
  readonly diagnose: (message: string) => void;
  /** 回执里印的文档路径（用户视角，由 `run.ts` 按 cwd 换算）；不给 = 印 workspace 相对名。 */
  readonly displayPath?: string | undefined;
}

export const serveCommandOf = (
  intent: Extract<Intent, { kind: "serve" }>,
  paths: { readonly workspace: string; readonly file: string },
  wiring: ServeWiring,
): Promise<string> => {
  // 显式 `--app-dir` 必须真实存在（exit 2）：depcruise 禁止 commands/* 碰 fs，M2.1 的缺省值仍由 core 兜底。
  if (intent.appDirGiven && intent.appDir !== undefined && !existsSync(intent.appDir)) {
    throw new HrError(
      "invalid_input",
      `--app-dir 目录不存在：${displayedPathOf(intent.appDir, wiring.cwd ?? process.cwd())}`,
    );
  }
  // core 的 `diagnose` 是"一句一说"、不带换行；CLI 的 stderr 是行通道，这一层补上。
  const diagnose = (message: string): void => {
    wiring.diagnose(`${message}\n`);
  };
  return serveCommand({
    file: paths.file,
    workspace: paths.workspace,
    port: intent.port,
    home: wiring.home,
    ...(intent.appDir === undefined ? {} : { appDir: intent.appDir }),
    json: intent.json,
    allowHosts: intent.allowHosts,
    stop: wiring.stop,
    exitWithParent: intent.exitWithParent,
    launchParentPid: wiring.launchParentPid,
    diagnose,
    displayPath: wiring.displayPath,
  });
};
