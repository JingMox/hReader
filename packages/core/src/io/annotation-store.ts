// This layer: the sidecar annotation file under `<workspace>/.hreader/annotations/<sha1>.json` —
// naming, corruption-tolerant reads, and the locked read-modify-write that backs up a corrupt
// file before overwriting. Locking stays with the caller (the per-file lock in ResolvedTarget),
// same convention as permissions.ts.

import { basename, dirname, join } from "node:path";

import {
  parseSidecarFile,
  serializeSidecarFile,
  SIDECAR_LIMITS,
  type SidecarAnnotation,
} from "../annotations/sidecar-model";
import { HrError } from "../hr-error";
import { mkdirOrFail, writeAtomic } from "./atomic";
import { decodeUtf8, encodeUtf8 } from "./bytes";
import { sha1Hex } from "./digest";
import { failureOf, isExists, isMissing } from "./errors";
import type { ResolvedTarget } from "./paths";
import type { PatchDeps } from "./ports";

/** One sidecar file per document: `<storeDir>/annotations/<sha1 of relative POSIX path>.json`. */
export const annotationPathOf = (storeDir: string, relative: string): string =>
  join(storeDir, "annotations", `${sha1Hex(relative)}.json`);

export const annotationDirOf = (target: ResolvedTarget): string =>
  join(target.storeDir, "annotations");

export const annotationFileOf = (target: ResolvedTarget): string =>
  annotationPathOf(target.storeDir, target.relative);

export interface SidecarFile {
  /** The file exists on disk (corrupt files exist too — they get backed up, not dropped). */
  readonly exists: boolean;
  /** `true` = read as empty but the on-disk bytes are unusable: the next write must rename them aside first. */
  readonly corrupt: boolean;
  readonly annotations: readonly SidecarAnnotation[];
  readonly diagnostics: readonly string[];
}

const EMPTY: SidecarFile = { exists: false, corrupt: false, annotations: [], diagnostics: [] };

const corruptRead = (diagnostic: string): SidecarFile => ({
  exists: true,
  corrupt: true,
  annotations: [],
  diagnostics: [diagnostic],
});

/**
 * Every read failure mode lands here except a missing file (= empty store): undecodable bytes,
 * oversize, bad JSON, wrong shape, dangerous keys, unknown version and path mismatch all read as
 * empty + one diagnostic, and mark the file corrupt so the next write preserves it aside.
 */
export const readSidecarFile = async (
  target: ResolvedTarget,
  deps: PatchDeps,
): Promise<SidecarFile> => readSidecarAt(annotationFileOf(target), target.relative, deps);

/**
 * The sidecar read for a path already named — same corruption-tolerant contract as
 * `readSidecarFile`, for callers that hold a `storeDir`/`relative` pair rather than a
 * resolved doc target (the search index's sidecar-only refresh).
 */
export const readSidecarAt = async (
  path: string,
  relative: string,
  deps: PatchDeps,
): Promise<SidecarFile> => {
  let bytes: Uint8Array;
  try {
    bytes = await deps.fs.readFile(path);
  } catch (error: unknown) {
    if (isMissing(error)) return EMPTY;
    throw failureOf("读取批注侧车文件", path, error);
  }
  if (bytes.length > SIDECAR_LIMITS.fileBytes) {
    return corruptRead(
      `侧车批注文件超过 ${String(SIDECAR_LIMITS.fileBytes)} 字节上限，按空批注处理`,
    );
  }
  let text: string;
  try {
    text = decodeUtf8(bytes, path);
  } catch {
    return corruptRead("侧车批注文件不是合法 UTF-8，按空批注处理");
  }
  const parsed = parseSidecarFile(text, relative);
  return {
    exists: true,
    corrupt: parsed.corrupt,
    annotations: parsed.annotations,
    diagnostics: parsed.diagnostics,
  };
};

/**
 * Bound on backup-name candidates: `BACKUP_ATTEMPTS` occupied same-stamp names means a stuck
 * clock or a hostile directory — the write fails closed rather than pick an unbounded suffix.
 */
const BACKUP_ATTEMPTS = 10;

/** The write clock rendered as `YYYYMMDDTHHmmssSSSZ`: ISO ordering without `:` or `.`. */
const backupStampOf = (at: Date): string => at.toISOString().replaceAll(/[-:.]/gu, "");

/**
 * Backup names are `<store>.corrupt-<stamp>[-N].json`: the stamp keeps ISO order while staying
 * legal on Windows filesystems, where `:` is a reserved character. Two corruptions inside one
 * millisecond share a stamp, so an occupied candidate takes `-1`, `-2`, … — each name is probed
 * before the rename and an `EEXIST` on the rename itself moves to the next suffix, so a lost
 * race never clobbers an earlier backup. After `BACKUP_ATTEMPTS` occupied names the write fails
 * closed. A vanished corrupt file needs no backup: an `ENOENT` on the rename is tolerated.
 */
const backupCorrupt = async (deps: PatchDeps, path: string): Promise<void> => {
  const stem = join(
    dirname(path),
    `${basename(path, ".json")}.corrupt-${backupStampOf(deps.clock.now())}`,
  );
  for (let attempt = 0; attempt < BACKUP_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 0 ? `${stem}.json` : `${stem}-${String(attempt)}.json`;
    try {
      await deps.fs.lstat(candidate);
      continue;
    } catch (error: unknown) {
      if (!isMissing(error)) throw failureOf("备份损坏的批注侧车文件", candidate, error);
    }
    try {
      await deps.fs.rename(path, candidate);
      return;
    } catch (error: unknown) {
      if (isMissing(error)) return;
      if (isExists(error)) continue;
      throw failureOf("备份损坏的批注侧车文件", path, error);
    }
  }
  throw new HrError(
    "io_failure",
    `备份损坏的批注侧车文件失败：${path}（${String(BACKUP_ATTEMPTS)} 个候选备份名均被占用）`,
  );
};

/**
 * Serialize → size check → back up a corrupt prior file → atomic write, in that order: a store
 * that fails the cap leaves the old file untouched, and a corrupt file is never silently
 * overwritten (renamed to `<name>.corrupt-<stamp>.json` first; a vanished one needs no backup).
 * The caller holds the per-file lock: the read passed as `prior` is the merge base, not a re-read.
 */
export const writeSidecarFile = async (
  target: ResolvedTarget,
  deps: PatchDeps,
  prior: SidecarFile,
  annotations: readonly SidecarAnnotation[],
): Promise<void> => {
  const path = annotationFileOf(target);
  const data = encodeUtf8(serializeSidecarFile(target.relative, annotations));
  if (data.length > SIDECAR_LIMITS.fileBytes) {
    throw new HrError(
      "invalid_payload",
      `批注侧车文件超过 ${String(SIDECAR_LIMITS.fileBytes)} 字节上限，拒绝写入`,
    );
  }
  if (prior.exists && prior.corrupt) {
    await backupCorrupt(deps, path);
  }
  await mkdirOrFail(deps, dirname(path));
  await writeAtomic({ path, workspace: target.workspace, data }, deps);
};
