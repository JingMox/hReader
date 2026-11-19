// 这层管：`hr serve` 的薄适配（起 core 的本地服务 → 打印端口/token 一行；关闭由 signal 驱动）。

import { HrError, nodePatchDeps, nodeStyleDeps, startServer } from "@hreader/core";

import { withNormalizeAdvice } from "../document-normalize";
import { dataServe, humanServe, jsonOk } from "../output";
import {
  PARENT_POLL_MS,
  orphanedAtLaunch,
  parentGone,
  parentWatchOf,
  type ParentWatch,
} from "../parent-guard";

export interface ServeInput {
  /** 已换算到 workspace 内的相对路径（与 patch/style 同一口径）。 */
  readonly file: string;
  readonly workspace: string;
  readonly port: number;
  /** `~/.hreader/daemon.json` 的父目录。 */
  readonly home: string;
  readonly json: boolean;
  /** 构建产物目录（`GET /`、`/assets/*` 的根）；`undefined` = 未配置（core 用 200 兜底首页）。 */
  readonly appDir?: string;
  /** `--allow-host`：整体替换默认的回环 Host 集合。 */
  readonly allowHosts?: readonly string[] | undefined;
  /** 由 `main.ts` 从 SIGTERM/SIGINT 解出的关闭信号。 */
  readonly stop: Promise<void>;
  /** `--exit-with-parent`：父进程（壳）消失就自己关；`false` = 不看父进程（默认，用户自己起的 daemon）。 */
  readonly exitWithParent?: boolean | undefined;
  /** core 的诊断出口（`::` 上另有监听、清理陈旧 `daemon.json`）：没有它就等于把这两件事静默掉。 */
  readonly diagnose?: ((message: string) => void) | undefined;
  /** 回执里印的文档路径（用户视角）：不给就印 workspace 相对名。 */
  readonly displayPath?: string | undefined;
  /** `main.ts` 在首个 `await` 之前采集的父 pid；落在这里是为了让"采集时机"只有一个来源。 */
  readonly launchParentPid: number;
}

export const serveCommand = async (input: ServeInput): Promise<string> => {
  // 壳已经死了才轮到这里：不建服务、不写 `daemon.json`，直接按可读错误退出——否则就是一个没人收的孤儿。
  if (shouldWatchParent(input.exitWithParent) && orphanedAtLaunch(input.launchParentPid)) {
    throw new HrError(
      "invalid_input",
      `--exit-with-parent 但启动时父进程已是 init（ppid=${String(input.launchParentPid)}）：父进程在启动窗口期就退了`,
    );
  }
  const appDir = input.appDir;
  const running = await startServer(
    {
      workspace: input.workspace,
      port: input.port,
      home: input.home,
      docId: input.file,
      ...(appDir === undefined ? {} : { appDir }),
      ...(input.diagnose === undefined ? {} : { diagnose: input.diagnose }),
      ...(input.allowHosts === undefined ? {} : { allowHosts: input.allowHosts }),
    },
    { patch: nodePatchDeps, style: nodeStyleDeps(input.workspace), now: Date.now },
  ).catch((error: unknown): never => {
    throw withNormalizeAdvice(error, input.file);
  });
  // 记下启动时的 ppid、之后每次轮询重读：壳被 kill -9 时 ppid 会变（re-parent 到 1 或 launchd），
  // 这是 daemon 唯一能自己发现"壳没了"的信号。
  const disposeWatch = watchParent(
    shouldWatchParent(input.exitWithParent) ? parentWatchOf(input.launchParentPid) : undefined,
    running,
  );
  // 先撤看门狗再关服务：定时器活过 `close()` 的话事件循环永远有活干，SIGTERM 之后进程就赖着不退。
  void input.stop.then(async () => {
    disposeWatch();
    await running.close();
  });
  return input.json
    ? jsonOk(dataServe(running.info))
    : humanServe(running.info, input.displayPath ?? input.file);
};

/** 只有壳显式要求时才看父进程：默认（用户自己起的 daemon）一个定时器都不许建。 */
export const shouldWatchParent = (exitWithParent: boolean | undefined): boolean =>
  exitWithParent === true;

/** 没有看门狗时的 disposer：调用点不必判空。 */
const nothingToDispose = (): void => undefined;

/// 每秒看一次父进程：壳被 `kill -9` 时它没有机会发信号，daemon 只能自己发现被 re-parent 了。
/// 返回 disposer：调用方（`serveCommand` 的 stop 路径）必须先撤掉定时器再关服务，否则 `close()` 跑完
/// 事件循环里还挂着一只 1s 的定时器，进程就永远不退——这正是 `--exit-with-parent` 收 SIGTERM 后不自杀的原因。
/// 导出只为单测（真实现要一个跑着的服务，假 `running` + 假时钟才能把三条分支都走到）。
export const watchParent = (
  watch: ParentWatch | undefined,
  running: { readonly close: () => Promise<void> },
): (() => void) => {
  if (watch === undefined) return nothingToDispose;
  const timer = setInterval(() => {
    if (!parentGone(watch)) return;
    clearInterval(timer);
    void running.close();
  }, PARENT_POLL_MS);
  // 与 core 的心跳（`server/hub.ts`）同口径：定时器不该成为"进程还活着"的唯一理由。
  timer.unref();
  return () => {
    clearInterval(timer);
  };
};
