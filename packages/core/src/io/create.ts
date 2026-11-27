// This layer: "create only if absent" (file_exists when present, never overwrites, never leaves a half file).
// The caller resolves the boundary once (resolveNewTarget); we re-check the parent's real path against it
// right before the landing call, writeAtomic-style — a mid-flight parent swap must not redirect the create.

import { randomInt } from "node:crypto";
import { dirname } from "node:path";

import { HrError } from "../hr-error";
import { assertParentInside } from "./atomic";
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
  workspace: string,
): Promise<void> => {
  const tmp = tmpNameOf(target);
  try {
    // writeAtomic-style: prove the landing dir is inside before staging, then re-prove before link —
    // a parent swap in between must not redirect either write.
    await assertParentInside(deps, dirname(target), workspace);
    await deps.fs.writeFileAtomic(tmp, data);
  } catch (error: unknown) {
    throw error instanceof HrError ? error : ioFailureOf("暂存新文件", tmp, error);
  }
  try {
    // The staging write is slow enough for a parent swap to slip in: re-prove the landing dir is inside.
    await assertParentInside(deps, dirname(target), workspace);
    await link(tmp, target);
  } catch (error: unknown) {
    throw error instanceof HrError
      ? error
      : isExists(error)
        ? existsFailure(target, error)
        : ioFailureOf("创建新文件", target, error);
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
const createViaOpen = async (
  target: string,
  data: Uint8Array,
  deps: PatchDeps,
  workspace: string,
): Promise<void> => {
  await assertParentInside(deps, dirname(target), workspace);
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

/**
 * The target's parent directory must already exist: mkdir is the caller's job (it knows whether to
 * create intermediate dirs). `workspace` is the boundary the caller resolved once; the parent's real
 * path is re-proved against it right before the landing call.
 */
export const createNewFile = async (
  target: string,
  data: Uint8Array,
  deps: PatchDeps,
  workspace: string,
): Promise<void> => {
  if (deps.fs.link !== undefined) {
    await createViaLink(target, data, deps.fs.link, deps, workspace);
    return;
  }
  await createViaOpen(target, data, deps, workspace);
};

/** Exclusively create a batch of files; on mid-way failure the already-created ones are reclaimed (dirs are not — rmdir is the caller's tracking problem). */
export const createNewFiles = async (
  files: readonly { readonly path: string; readonly data: Uint8Array }[],
  deps: PatchDeps,
  workspace: string,
): Promise<void> => {
  const created: string[] = [];
  try {
    for (const file of files) {
      await createNewFile(file.path, file.data, deps, workspace);
      created.push(file.path);
    }
  } catch (error: unknown) {
    for (const path of created) await unlinkQuiet(deps.fs, path);
    throw error;
  }
};
