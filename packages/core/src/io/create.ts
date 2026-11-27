// This layer: "create only if absent" (file_exists when present, never overwrites, never leaves a half file).
// Ownership/escape checks belong to the caller; here we only guarantee the create semantics itself.

import { randomInt } from "node:crypto";

import { HrError } from "../hr-error";
import { isExists, unlinkQuiet } from "./errors";
import type { OpenFile, PatchDeps } from "./ports";

/** `<target>.<digits>` shares the shape of atomic.ts's `RESIDUE_SUFFIX`: crash residue is reclaimed by the next writeAtomic. */
const tmpNameOf = (target: string): string =>
  `${target}.${String(randomInt(100_000, 1_000_000_000))}`;

const existsFailure = (path: string, cause: unknown): HrError =>
  new HrError("file_exists", `目标已存在：${path}`, { cause });

const ioFailureOf = (action: string, path: string, error: unknown): HrError =>
  new HrError("io_failure", `${action}失败：${path}`, { cause: error });

/**
 * tmp + `link(2)`: tmp is fully landed first via writeFileAtomic (fsync + umask permissions),
 * then link hands "create only if absent" to the kernel — EEXIST never overwrites,
 * and a mid-flight crash leaves no half file. tmp sits in the target's own directory, so link cannot cross devices.
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

/** Fallback when the port has no `link`: exclusive O_EXCL create via `open`; a mid-write crash leaves a half file (weaker than the link path). */
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

/** The target's parent directory must already exist: mkdir is the caller's job (it knows whether to create intermediate dirs). */
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

/** Exclusively create a batch of files; on mid-way failure the already-created ones are reclaimed (dirs are not — the port has no rmdir). */
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
