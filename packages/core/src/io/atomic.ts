// 这层管：原子写（同目录 tmp → fsync → 双重复核 → rename）与按归属回收遗留 tmp；不校验内容。

import { basename, dirname, join } from "node:path";

import { HrError } from "../hr-error";
import { nonce } from "./digest";
import { failureOf, ioFailure } from "./errors";
import { unlinkQuiet } from "./fs-ops";
import { isInsideOrSelf } from "./paths";
import type { PatchDeps } from "./ports";
import { isProcessAlive } from "./process";

/** tmp 名带 pid：回收时只动"pid 已死或年龄超 5min"的，绝不按前缀一刀切。 */
export const TMP_PREFIX = ".hr-tmp.";

const TMP_STALE_MS = 5 * 60_000;

const TMP_PATTERN = /^\.hr-tmp\.(\d+)\.([0-9a-f]+)\./u;

const pidOfTmp = (name: string): number | undefined => {
  const matched = TMP_PATTERN.exec(name);
  return matched === null ? undefined : Number(matched[1]);
};

const statQuiet = async (
  deps: PatchDeps,
  path: string,
): Promise<{ alive: boolean; age: number }> => {
  try {
    const stat = await deps.fs.lstat(path);
    return { alive: true, age: deps.clock.now().getTime() - stat.mtimeMs };
  } catch {
    return { alive: false, age: 0 };
  }
};

/** 只有"名字能解析出 pid、且确实没人在写"的 tmp 才是遗留物；其余一律当活文件。 */
const isRemovableTmp = async (deps: PatchDeps, dir: string, name: string): Promise<boolean> => {
  const pid = pidOfTmp(name);
  if (pid === undefined) return false;
  const stat = await statQuiet(deps, join(dir, name));
  if (!stat.alive) return false;
  return !isProcessAlive(pid) || stat.age > TMP_STALE_MS;
};

export const removeStaleTmp = async (deps: PatchDeps, dir: string): Promise<void> => {
  const names = await deps.fs.readdir(dir);
  for (const name of names) {
    if (await isRemovableTmp(deps, dir, name)) await unlinkQuiet(deps.fs, join(dir, name));
  }
};

/** P0-1：写 tmp 前与 rename 前各复核一次父目录真实路径；父目录中途被换成外链就停手。 */
const assertParentInside = async (
  deps: PatchDeps,
  dir: string,
  workspace: string,
): Promise<void> => {
  let real: string;
  try {
    real = await deps.fs.realpath(dir);
  } catch (error: unknown) {
    // fail-closed：解析不了就无法证明落点仍在 workspace 内，一律按逃逸拒绝（P0-1 的复核点）。
    throw new HrError("path_outside_workspace", `父目录已无法解析，拒绝写入：${dir}`, {
      cause: error,
    });
  }
  if (!isInsideOrSelf(workspace, real)) {
    throw new HrError("path_outside_workspace", `父目录真实路径已跑出 workspace：${real}`);
  }
};

const assertTargetNotLink = async (deps: PatchDeps, path: string): Promise<void> => {
  try {
    const stat = await deps.fs.lstat(path);
    if (stat.isSymbolicLink()) {
      throw new HrError("path_outside_workspace", `rename 目标已变成符号链接，拒绝写入：${path}`);
    }
  } catch (error: unknown) {
    if (error instanceof HrError) throw error;
    // 目标不存在（ENOENT）是正常路径：rename 会新建它。
  }
};

const writeTmp = async (deps: PatchDeps, tmpPath: string, data: Uint8Array): Promise<void> => {
  const file = await deps.fs.open(tmpPath, "wx-nofollow");
  try {
    await file.write(data);
    await file.sync();
  } finally {
    await deps.fs.close(file);
  }
};

interface AtomicInput {
  readonly path: string;
  readonly workspace: string;
  readonly data: Uint8Array;
}

const OWNER_WRITE = 0o200;
const PERMISSION_BITS = 0o7777;

/** 目标已存在时的 mode；`undefined` = 不存在（新建，权限交给 umask）。 */
const targetModeOf = async (deps: PatchDeps, path: string): Promise<number | undefined> => {
  try {
    return (await deps.fs.lstat(path)).mode;
  } catch {
    // 只有“不存在”算新建；其余失败会在写/rename 上以准确报文暴露，不在这里抢先判死。
    return undefined;
  }
};

/**
 * 临时文件 + rename 会绕过目标自己的只读位：444 的文件照样被改写，用户以为设了只读就安全。
 * 只拦“owner 写位为 0”，不看 group/other——那是共享目录的既有习惯，不该由这里重新解释。
 */
const assertWritable = (path: string, mode: number | undefined): void => {
  if (mode === undefined || (mode & OWNER_WRITE) !== 0) return;
  throw new HrError("io_failure", `文件是只读的，拒绝改写：${path}（先 chmod +w ${path}）`);
};

/** 先给 tmp 定成原文件的权限再 rename：不这么做，一次改写就会把用户设的权限位静默改掉。 */
const applyMode = async (
  deps: PatchDeps,
  path: string,
  mode: number | undefined,
): Promise<void> => {
  if (mode === undefined || deps.fs.chmod === undefined) return;
  await deps.fs.chmod(path, mode & PERMISSION_BITS);
};

/** `rename` 前任一步失败都回到"原文件未动"：tmp 删掉、抛 `io_failure`（cause 保留原错）。 */
export const writeAtomic = async (input: AtomicInput, deps: PatchDeps): Promise<void> => {
  const dir = dirname(input.path);
  const tmpPath = join(
    dir,
    `${TMP_PREFIX}${String(process.pid)}.${nonce()}.${basename(input.path)}`,
  );
  const mode = await targetModeOf(deps, input.path);
  try {
    assertWritable(input.path, mode);
    await assertParentInside(deps, dir, input.workspace);
    await removeStaleTmp(deps, dir);
    await writeTmp(deps, tmpPath, input.data);
    await applyMode(deps, tmpPath, mode);
    await assertParentInside(deps, dir, input.workspace);
    await assertTargetNotLink(deps, input.path);
    await deps.fs.rename(tmpPath, input.path);
  } catch (error: unknown) {
    await unlinkQuiet(deps.fs, tmpPath);
    throw error instanceof HrError ? error : ioFailure("原子写", input.path, error);
  }
};

/** 建目录失败的报错口径与写文件保持一致。 */
export const mkdirOrFail = async (deps: PatchDeps, path: string): Promise<void> => {
  try {
    await deps.fs.mkdir(path);
  } catch (error: unknown) {
    throw failureOf("建目录", path, error);
  }
};
