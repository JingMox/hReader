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
import { failureOf, isMissing } from "./errors";
import type { ResolvedTarget } from "./paths";
import type { PatchDeps } from "./ports";

/** One sidecar file per document: `<sha1 of workspace-relative POSIX path>.json`. */
export const annotationDirOf = (target: ResolvedTarget): string =>
  join(target.storeDir, "annotations");

export const annotationFileOf = (target: ResolvedTarget): string =>
  join(annotationDirOf(target), `${sha1Hex(target.relative)}.json`);

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
): Promise<SidecarFile> => {
  const path = annotationFileOf(target);
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
  const parsed = parseSidecarFile(text, target.relative);
  return {
    exists: true,
    corrupt: parsed.corrupt,
    annotations: parsed.annotations,
    diagnostics: parsed.diagnostics,
  };
};

const corruptBackupOf = (path: string, at: string): string =>
  join(dirname(path), `${basename(path, ".json")}.corrupt-${at}.json`);

/**
 * Serialize → size check → back up a corrupt prior file → atomic write, in that order: a store
 * that fails the cap leaves the old file untouched, and a corrupt file is never silently
 * overwritten (renamed to `<name>.corrupt-<clock>.json` first; a vanished one needs no backup).
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
    const backup = corruptBackupOf(path, deps.clock.now().toISOString());
    try {
      await deps.fs.rename(path, backup);
    } catch (error: unknown) {
      if (!isMissing(error)) throw failureOf("备份损坏的批注侧车文件", path, error);
    }
  }
  await mkdirOrFail(deps, dirname(path));
  await writeAtomic({ path, workspace: target.workspace, data }, deps);
};
