// 这层管：`hr serve` 的薄适配（起 core 的本地服务 → 打印端口/token 一行；关闭由 signal 驱动）。

import { nodePatchDeps, nodeStyleDeps, startServer } from "@hreader/core";

import { dataServe, humanServe, jsonOk } from "../output";

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
}

export const serveCommand = async (input: ServeInput): Promise<string> => {
  const appDir = input.appDir;
  const running = await startServer(
    {
      workspace: input.workspace,
      port: input.port,
      home: input.home,
      docId: input.file,
      ...(appDir === undefined ? {} : { appDir }),
      ...(input.allowHosts === undefined ? {} : { allowHosts: input.allowHosts }),
    },
    { patch: nodePatchDeps, style: nodeStyleDeps(input.workspace), now: Date.now },
  );
  void input.stop.then(async () => {
    await running.close();
  });
  return input.json ? jsonOk(dataServe(running.info)) : humanServe(running.info);
};
