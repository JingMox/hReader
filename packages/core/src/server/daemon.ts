// 这层管：`~/.hreader/daemon.json` 的读写删（原子写 + 0600）与"是否有点在听"的探活；不管 HTTP。

import { chmod } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, join } from "node:path";

import { z } from "zod";

import { encodeUtf8, decodeUtf8 } from "../io/bytes";
import { mkdirOrFail } from "../io/atomic";
import { nonce } from "../io/digest";
import { failureOf, ioFailure, isMissing } from "../io/errors";
import type { PatchDeps } from "../io/ports";
import { isProcessAlive } from "../io/process";
import { parseJson } from "../schema";

const STORE_DIR = ".hreader";
const DAEMON_FILE = "daemon.json";

export const daemonFileOf = (home: string): string => join(home, STORE_DIR, DAEMON_FILE);

const positiveInt = z.number().int().positive();
const nonEmpty = z.string().min(1);

/** `daemon.json` 的形状：CLI 与浏览器都靠它拿端口与一次性 token。 */
const daemonSchema = z.object({
  port: positiveInt,
  token: nonEmpty,
  pid: positiveInt,
  workspace: nonEmpty,
});

export type DaemonInfo = Readonly<z.infer<typeof daemonSchema>>;

/** 字段类型不对就当"没有 daemon"：坏文件不能把新进程挡在门外，也不能被当成自己的。 */
export const parseDaemon = (text: string): DaemonInfo | undefined => {
  const parsed = daemonSchema.safeParse(parseJson(text));
  return parsed.success ? parsed.data : undefined;
};

export const readDaemonOf = async (
  home: string,
  deps: PatchDeps,
): Promise<DaemonInfo | undefined> => {
  const file = daemonFileOf(home);
  let bytes: Uint8Array;
  try {
    bytes = await deps.fs.readFile(file);
  } catch (error: unknown) {
    if (isMissing(error)) return undefined;
    throw ioFailure("读取 daemon.json", file, error);
  }
  return parseDaemon(decodeUtf8(bytes, file));
};

/** 先落到同目录 tmp 再 rename：读者要么看不到文件，要么看到完整 JSON，不会读到半截。 */
export const writeDaemonOf = async (
  info: DaemonInfo,
  home: string,
  deps: PatchDeps,
): Promise<string> => {
  const file = daemonFileOf(home);
  const dir = dirname(file);
  await mkdirOrFail(deps, dir);
  const tmp = `${file}.${String(process.pid)}.${nonce()}.tmp`;
  try {
    await deps.fs.writeFile(tmp, encodeUtf8(JSON.stringify(info)));
    await chmod(tmp, 0o600);
    await deps.fs.rename(tmp, file);
  } catch (error: unknown) {
    // 写/改权限/rename 任一步失败都不能留 tmp：目录里躺着一个 0600 的 token 文件等于泄漏。
    await deps.fs.unlink(tmp).catch(() => undefined);
    throw failureOf("写 daemon.json", tmp, error);
  }
  return file;
};

/** 只删自己写的：pid 变了说明另一个 daemon 已经接管，删掉会误伤别人。 */
export const removeDaemonOf = async (
  home: string,
  pid: number,
  deps: PatchDeps,
): Promise<boolean> => {
  const file = daemonFileOf(home);
  const info = await readDaemonOf(home, deps);
  if (info?.pid !== pid) return false;
  try {
    await deps.fs.unlink(file);
    return true;
  } catch (error: unknown) {
    if (isMissing(error)) return false;
    throw ioFailure("删除 daemon.json", file, error);
  }
};

export const daemonAlive = (info: DaemonInfo): boolean => isProcessAlive(info.pid);

/**
 * 陈旧 = 记录里的持有者已经不在了（`EPERM` 按存活算）：这种文件只是垃圾，删掉继续。
 * `isAlive` 可注入，便于测试用假 pid 覆盖“活着/已死/无权限”三态。
 */
export const staleDaemonOf = (
  info: DaemonInfo,
  isAlive: (pid: number) => boolean = isProcessAlive,
): boolean => !isAlive(info.pid);

/** 探活用真连接：pid 可能是被复用的无关进程，端口能连上才算"有一个 daemon 在听"。 */
export const portOpen = (port: number, timeoutMs: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (open: boolean): void => {
      socket.destroy();
      resolve(open);
    };
    const timer = setTimeout(() => {
      finish(false);
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      finish(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      finish(false);
    });
  });
