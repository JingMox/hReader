// This layer: "create only if absent"（已存在即 file_exists，绝不覆盖，绝不留下半成品文件）。
// 归属/逃逸判定归调用方；这里只保证创建语义本身。

import { randomInt } from "node:crypto";

import { HrError } from "../hr-error";
import { isExists, unlinkQuiet } from "./errors";
import type { OpenFile, PatchDeps } from "./ports";

/** `<目标>.<数字>` 与 atomic.ts 的 `RESIDUE_SUFFIX` 同形：崩殁残留会被下次 writeAtomic 顺手回收。 */
const tmpNameOf = (target: string): string =>
  `${target}.${String(randomInt(100_000, 1_000_000_000))}`;

const existsFailure = (path: string, cause: unknown): HrError =>
  new HrError("file_exists", `目标已存在：${path}`, { cause });

const ioFailureOf = (action: string, path: string, error: unknown): HrError =>
  new HrError("io_failure", `${action}失败：${path}`, { cause: error });

/**
 * tmp + `link(2)`：tmp 先经 writeFileAtomic 落满（fsync + umask 权限），link 把
 * "仅当不存在才创建"交给内核——EEXIST 不覆盖、进程中途死也不留半个文件。
 * tmp 与目标同目录，link 不可能跨设备。
 */
const createViaLink = async (
  target: string,
  data: Uint8Array,
  link: NonNullable<PatchDeps["fs"]["link"]>,
  deps: PatchDeps,
): Promise<void> => {
  const tmp = tmpNameOf(target);
  try {
    await deps.fs.writeFileAtomic(tmp, data);
  } catch (error: unknown) {
    throw ioFailureOf("暂存新文件", tmp, error);
  }
  try {
    await link(tmp, target);
  } catch (error: unknown) {
    throw isExists(error) ? existsFailure(target, error) : ioFailureOf("创建新文件", target, error);
  } finally {
    await unlinkQuiet(deps.fs, tmp);
  }
};

const openExclusive = async (target: string, deps: PatchDeps): Promise<OpenFile> => {
  try {
    return await deps.fs.open(target);
  } catch (error: unknown) {
    throw isExists(error) ? existsFailure(target, error) : ioFailureOf("创建新文件", target, error);
  }
};

/** 无 `link` 端口的退路：`open` 的 O_EXCL 独占创建；写一半崩殁会留下半成品（弱于 link 路径）。 */
const createViaOpen = async (target: string, data: Uint8Array, deps: PatchDeps): Promise<void> => {
  const file = await openExclusive(target, deps);
  try {
    await file.write(data);
    await file.sync();
  } catch (error: unknown) {
    await unlinkQuiet(deps.fs, target);
    throw ioFailureOf("写入新文件", target, error);
  } finally {
    await deps.fs.close(file);
  }
};

/** 目标父目录必须先存在：mkdir 是调用方的事（它知道该不该补中间目录）。 */
export const createNewFile = async (
  target: string,
  data: Uint8Array,
  deps: PatchDeps,
): Promise<void> => {
  if (deps.fs.link !== undefined) {
    await createViaLink(target, data, deps.fs.link, deps);
    return;
  }
  await createViaOpen(target, data, deps);
};

/** 独占创建一批文件；中途失败时回收已创建的部分（目录不回收——端口没有 rmdir）。 */
export const createNewFiles = async (
  files: readonly { readonly path: string; readonly data: Uint8Array }[],
  deps: PatchDeps,
): Promise<void> => {
  const created: string[] = [];
  try {
    for (const file of files) {
      await createNewFile(file.path, file.data, deps);
      created.push(file.path);
    }
  } catch (error: unknown) {
    for (const path of created) await unlinkQuiet(deps.fs, path);
    throw error;
  }
};
