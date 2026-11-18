// 这层管：把 serve 意图装配成 `ServeInput`（别的命令的装配留在 `run.ts`）。
// 单独成文件只为职责边界：`run.ts` 只做分发，而 serve 是唯一要凑齐 `--app-dir` / `--allow-host` / 看门狗三项的命令。

import { existsSync } from "node:fs";

import { HrError } from "@hreader/core";

import type { Intent } from "./args";
import { serveCommand } from "./commands/serve";

/** 分发层已经归一好的三样东西：`--home` 的落点、停止口、以及"父 pid 只采集一次"的那次采集。 */
interface ServeWiring {
  /** `--home` 缺省时的落点（`run` 已把 `homedir()` 归到这里）。 */
  readonly home: string;
  readonly stop: Promise<void>;
  /** 进程壳在首个 `await` 之前采集的父 pid；这里没有兜底——晚读 `process.ppid` 就是 B5/(W2) 那个洞。 */
  readonly launchParentPid: number;
}

export const serveCommandOf = (
  intent: Extract<Intent, { kind: "serve" }>,
  paths: { readonly workspace: string; readonly file: string },
  wiring: ServeWiring,
): Promise<string> => {
  // 显式 `--app-dir` 必须真实存在（exit 2）：depcruise 禁止 commands/* 碰 fs，M2.1 的缺省值仍由 core 兜底。
  if (intent.appDirGiven && intent.appDir !== undefined && !existsSync(intent.appDir)) {
    throw new HrError("invalid_input", `--app-dir 目录不存在：${intent.appDir}`);
  }
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
  });
};
