// 这层管：原子写的领域编排（可写位、workspace 内复核、目标非链、遗留 tmp 回收）与按归属回收；
// `tmp → fsync → 沿用权限位 → rename` 的通用段交给 `FileSystem.writeFileAtomic`；不校验内容。

import { basename, dirname, join } from "node:path";

import { HrError } from "../hr-error";
import { failureOf, ioFailure, unlinkQuiet } from "./errors";
import { isInsideOrSelf } from "./paths";
import type { PatchDeps } from "./ports";
import { isProcessAlive } from "./process";

/** 旧版 tmp 前缀（`.hr-tmp.<pid>.<nonce>.<name>`）：server 按它过滤监听噪声，旧残留也靠它识别。 */
export const TMP_PREFIX = ".hr-tmp.";

const TMP_STALE_MS = 5 * 60_000;

const TMP_PATTERN = /^\.hr-tmp\.(\d+)\.([0-9a-f]+)\./u;

/**
 * write-file-atomic 的崩溃残留是 `<目标名>.<十进制数>`：数字段要求 6 位以上，
 * 避免把 `report.html.2024` 这类用户文件错收成 tmp。
 */
const RESIDUE_SUFFIX = /\.\d{6,}$/u;

/** 监听噪声过滤用：不绑定目标名，只看结尾形状，与残留回收同一个口径。 */
export const isTmpFileName = (name: string): boolean =>
  name.startsWith(TMP_PREFIX) || RESIDUE_SUFFIX.test(name);

const isResidueName = (name: string, targetName: string): boolean =>
  name.startsWith(`${targetName}.`) && RESIDUE_SUFFIX.test(name.slice(targetName.length));

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

/**
 * 旧格式：名字里带 pid，只动"pid 已死或年龄超 5min"的，绝不按前缀一刀切；
 * 新格式（`<target>.<digits>`）没有归属信息，只能放宽到"够老才收"。
 */
const isRemovableTmp = async (
  deps: PatchDeps,
  dir: string,
  name: string,
  targetName: string,
): Promise<boolean> => {
  const pid = pidOfTmp(name);
  if (pid === undefined && !isResidueName(name, targetName)) return false;
  const stat = await statQuiet(deps, join(dir, name));
  if (!stat.alive) return false;
  if (pid !== undefined) return !isProcessAlive(pid) || stat.age > TMP_STALE_MS;
  return stat.age > TMP_STALE_MS;
};

export const removeStaleTmp = async (
  deps: PatchDeps,
  dir: string,
  targetName: string,
): Promise<void> => {
  const names = await deps.fs.readdir(dir);
  for (const name of names) {
    if (await isRemovableTmp(deps, dir, name, targetName)) {
      await unlinkQuiet(deps.fs, join(dir, name));
    }
  }
};

/** 写 tmp 前与落盘前各复核一次父目录真实路径；父目录中途被换成外链就停手。 */
const assertParentInside = async (
  deps: PatchDeps,
  dir: string,
  workspace: string,
): Promise<void> => {
  let real: string;
  try {
    real = await deps.fs.realpath(dir);
  } catch (error: unknown) {
    // fail-closed：解析不了就无法证明落点仍在 workspace 内，一律按逃逸拒绝。
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
    // 目标不存在（ENOENT）是正常路径：写文件会新建它。
  }
};

interface AtomicInput {
  readonly path: string;
  readonly workspace: string;
  readonly data: Uint8Array;
}

const OWNER_WRITE = 0o200;

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

/**
 * 顺序即保证：先拒绝只读/逃逸，再清同文件的历史残留，最后把两段复核压到落盘调用之前。
 * 落盘本身（tmp + fsync + 权限沿用 + rename + 清理）由端口一次完成，中途失败时由它清 tmp、
 * 抛系统错，这里统一翻成 `io_failure`。
 */
export const writeAtomic = async (input: AtomicInput, deps: PatchDeps): Promise<void> => {
  const dir = dirname(input.path);
  const mode = await targetModeOf(deps, input.path);
  try {
    assertWritable(input.path, mode);
    await assertParentInside(deps, dir, input.workspace);
    await removeStaleTmp(deps, dir, basename(input.path));
    await assertTargetNotLink(deps, input.path);
    await assertParentInside(deps, dir, input.workspace);
    await deps.fs.writeFileAtomic(input.path, input.data);
  } catch (error: unknown) {
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
