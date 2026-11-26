// 这层管：`hr serve` 常驻进程的起停（回执行 → DaemonInfo；SIGTERM 收尾验证 daemon.json 清掉）。

import { existsSync } from "node:fs";
import { join } from "node:path";

import { assert, parseJson } from "./check.ts";
import type { JsonObject } from "./cli.ts";
import { APP_DIR, CLI_BIN } from "./env.ts";
import { live, type LiveProc } from "./proc.ts";

export interface Daemon {
  readonly port: number;
  readonly token: string;
  readonly url: string;
  readonly pid: number;
  readonly proc: LiveProc;
  readonly home: string;
  /** SIGTERM → 等待退出；返回退出码（被信号杀时为 null）。 */
  readonly stop: () => Promise<number | null>;
}

export interface ServeOptions {
  readonly file: string;
  readonly workspace: string;
  readonly home: string;
  readonly extraArgs?: readonly string[];
}

export const daemonJsonPath = (home: string): string => join(home, ".hreader", "daemon.json");

export const daemonFileExists = (home: string): boolean => existsSync(daemonJsonPath(home));

/**
 * `--port 0` 由内核分配：测试之间（以及和并行 agent）不撞端口。
 * 回执是 stdout 第一行 `--json`；读不到行就是启动失败，附 stderr 一起报。
 */
export const startServe = async (options: ServeOptions): Promise<Daemon> => {
  const proc = live(
    process.execPath,
    [
      CLI_BIN,
      "serve",
      options.file,
      "--workspace",
      options.workspace,
      "--home",
      options.home,
      "--app-dir",
      APP_DIR,
      "--port",
      "0",
      "--json",
      ...(options.extraArgs ?? []),
    ],
    { cwd: options.workspace },
  );
  const line = await proc.nextLine(20_000);
  assert(line !== undefined, `hr serve 没有打出回执（stderr：${proc.out.err().slice(0, 400)}）`);
  const parsed = parseJson(line, "hr serve 回执");
  assert(typeof parsed === "object" && parsed !== null, `hr serve 回执不是对象：${line}`);
  assert(Reflect.get(parsed, "ok") === true, `hr serve 回执不是 ok：${line}`);
  const dataRaw: unknown = Reflect.get(parsed, "data");
  assert(typeof dataRaw === "object" && dataRaw !== null, `hr serve 回执缺 data：${line}`);
  const data = dataRaw as JsonObject;
  const port = data["port"];
  const token = data["token"];
  const url = data["url"];
  const pid = data["pid"];
  assert(
    typeof port === "number" && typeof token === "string" && typeof url === "string",
    `hr serve 回执字段不全：${line}`,
  );
  return {
    port,
    token,
    url,
    pid: typeof pid === "number" ? pid : proc.pid,
    proc,
    home: options.home,
    stop: async () => {
      proc.kill("SIGTERM");
      return await proc.exited;
    },
  };
};
