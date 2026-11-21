// 这层管：端口的真实实现（本包唯一 import node:fs 的文件）；不含任何业务规则。

import { constants, existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import type { Clock, FileSystem, OpenFile, OpenMode, PatchDeps } from "./ports";

const handles = new WeakMap<OpenFile, FileHandle>();

/** `wx-nofollow` = `O_CREAT|O_EXCL|O_NOFOLLOW`：tmp 名被预先放成符号链接时直接失败（P0-1）。 */
const flagsOf = (mode: OpenMode): string | number =>
  mode === "wx"
    ? "wx"
    : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

const openExclusive = async (path: string, mode: OpenMode): Promise<OpenFile> => {
  const handle = await open(path, flagsOf(mode));
  const file: OpenFile = {
    write: async (data) => {
      await handle.write(data);
    },
    sync: async () => {
      await handle.sync();
    },
  };
  handles.set(file, handle);
  return file;
};

const closeExclusive = async (file: OpenFile): Promise<void> => {
  const handle = handles.get(file);
  if (handle === undefined) return;
  handles.delete(file);
  await handle.close();
};

const nodeFileSystem: FileSystem = {
  readFile: async (path) => readFile(path),
  writeFile: async (path, data) => {
    await writeFile(path, data);
  },
  rename: async (from, to) => {
    await rename(from, to);
  },
  unlink: async (path) => {
    await unlink(path);
  },
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  lstat: async (path) => lstat(path),
  chmod: async (path, mode) => {
    await chmod(path, mode);
  },
  readdir: async (path) => readdir(path),
  realpath: async (path) => realpath(path),
  open: openExclusive,
  close: closeExclusive,
};

const systemClock: Clock = { now: () => new Date() };

/** 供默认依赖装配时同步探测内置资源目录是否存在。 */
export const nodePathExists = (path: string): boolean => existsSync(path);

/** CLI 与集成测试用的默认依赖；测试要换 fs/clock/sleep 就自己组一个 `PatchDeps`。 */
export const nodePatchDeps: PatchDeps = {
  fs: nodeFileSystem,
  clock: systemClock,
  sleep: (ms) => delay(ms),
};
