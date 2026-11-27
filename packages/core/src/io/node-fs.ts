// 这层管：端口的真实实现（本包唯一 import node:fs 与 write-file-atomic 的文件）；不含任何业务规则。

import { existsSync } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import writeFileAtomic from "write-file-atomic";

import type { Clock, FileSystem, OpenFile, PatchDeps } from "./ports";

const handles = new WeakMap<OpenFile, FileHandle>();

const openExclusive = async (path: string): Promise<OpenFile> => {
  const handle = await open(path, "wx");
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
  link: async (from, to) => {
    await link(from, to);
  },
  unlink: async (path) => {
    await unlink(path);
  },
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  rmdir: async (path) => {
    await rmdir(path);
  },
  lstat: async (path) => lstat(path),
  readdir: async (path) => readdir(path),
  realpath: async (path) => realpath(path),
  open: openExclusive,
  close: closeExclusive,
  writeFileAtomic: async (path, data) => {
    await writeFileAtomic(path, Buffer.from(data));
  },
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
