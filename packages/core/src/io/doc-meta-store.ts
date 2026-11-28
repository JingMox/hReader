// This layer: the shared document-metadata table at `<workspace>/.hreader/meta.json` —
// naming, corruption-tolerant reads, and the read-modify-write that backs up a corrupt file
// before overwriting (same `.corrupt-<stamp>[-N].json` naming the annotation store uses).
// The table is one file for the whole workspace, so its lock is table-wide (`locks/<sha1>` —
// the same convention the search index uses), taken by the ops layer.

import { basename, dirname, join } from "node:path";

import {
  DOC_META_LIMITS,
  parseDocMetaFile,
  serializeDocMetaFile,
  type DocMetaRecord,
} from "../docmeta";
import { HrError } from "../hr-error";
import { mkdirOrFail, writeAtomic } from "./atomic";
import { decodeUtf8, encodeUtf8 } from "./bytes";
import { sha1Hex } from "./digest";
import { failureOf, isExists, isMissing } from "./errors";
import type { ResolvedTarget } from "./paths";
import type { PatchDeps } from "./ports";

/** The single metadata table file, directly under the workspace's `.hreader/` store root. */
export const META_STORE_FILE = "meta.json";

/** Workspace-relative POSIX spelling of the table — the same value feeds the lock-key hash. */
export const META_REL = ".hreader/meta.json";

export const metaPathOf = (storeDir: string): string => join(storeDir, META_STORE_FILE);

/** Table-wide lock: one shared file means every doc's meta write serializes on the same lock. */
export const metaLockOf = (storeDir: string): string =>
  join(storeDir, "locks", `${sha1Hex(META_REL)}.lock`);

export interface DocMetaFile {
  /** The file exists on disk (corrupt files exist too — they get backed up, not dropped). */
  readonly exists: boolean;
  /** `true` = read as empty but the on-disk bytes are unusable: the next write must rename them aside first. */
  readonly corrupt: boolean;
  /** Records keyed by workspace-relative POSIX path (prototype-free). */
  readonly docs: Readonly<Record<string, DocMetaRecord>>;
  readonly diagnostics: readonly string[];
}

const EMPTY: DocMetaFile = {
  exists: false,
  corrupt: false,
  docs: Object.create(null) as Record<string, DocMetaRecord>,
  diagnostics: [],
};

const corruptRead = (diagnostic: string): DocMetaFile => ({
  exists: true,
  corrupt: true,
  docs: Object.create(null) as Record<string, DocMetaRecord>,
  diagnostics: [diagnostic],
});

/**
 * Every read failure mode lands here except a missing file (= empty table): undecodable bytes,
 * oversize, bad JSON, wrong shape, dangerous keys and unknown version all read as empty + one
 * code-only diagnostic (`doc_meta_corrupt:<reason>`), and mark the file corrupt so the next
 * write preserves it aside.
 */
export const readDocMetaFile = async (
  target: ResolvedTarget,
  deps: PatchDeps,
): Promise<DocMetaFile> => readDocMetaAt(metaPathOf(target.storeDir), deps);

/**
 * The table read for a path already named — same corruption-tolerant contract as
 * `readDocMetaFile`, for callers that hold a `storeDir` rather than a resolved doc target
 * (the search index's tag refresh).
 */
export const readDocMetaAt = async (path: string, deps: PatchDeps): Promise<DocMetaFile> => {
  let bytes: Uint8Array;
  try {
    bytes = await deps.fs.readFile(path);
  } catch (error: unknown) {
    if (isMissing(error)) return EMPTY;
    throw failureOf("读取文档元数据表", path, error);
  }
  if (bytes.length > DOC_META_LIMITS.fileBytes) {
    return corruptRead("doc_meta_corrupt:too_large");
  }
  let text: string;
  try {
    text = decodeUtf8(bytes, path);
  } catch {
    return corruptRead("doc_meta_corrupt:bad_utf8");
  }
  const parsed = parseDocMetaFile(text);
  return {
    exists: true,
    corrupt: parsed.corrupt,
    docs: parsed.docs,
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
 * Backup names are `<store>.corrupt-<stamp>[-N].json` — identical naming to the annotation
 * store: the stamp keeps ISO order while staying legal on Windows filesystems, an occupied
 * candidate takes `-1`, `-2`, … and an `EEXIST` on the rename itself moves to the next suffix,
 * so a lost race never clobbers an earlier backup. After `BACKUP_ATTEMPTS` occupied names the
 * write fails closed. A vanished corrupt file needs no backup: `ENOENT` is tolerated.
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
      if (!isMissing(error)) throw failureOf("备份损坏的文档元数据表", candidate, error);
    }
    try {
      await deps.fs.rename(path, candidate);
      return;
    } catch (error: unknown) {
      if (isMissing(error)) return;
      if (isExists(error)) continue;
      throw failureOf("备份损坏的文档元数据表", path, error);
    }
  }
  throw new HrError(
    "io_failure",
    `备份损坏的文档元数据表失败：${path}（${String(BACKUP_ATTEMPTS)} 个候选备份名均被占用）`,
  );
};

/**
 * Serialize → size check → back up a corrupt prior file → atomic write, in that order: a table
 * that fails the cap leaves the old file untouched, and a corrupt file is never silently
 * overwritten. The caller holds the table lock: the read passed as `prior` is the merge base,
 * not a re-read.
 */
export const writeDocMetaFile = async (
  target: ResolvedTarget,
  deps: PatchDeps,
  prior: DocMetaFile,
  docs: Readonly<Record<string, DocMetaRecord>>,
): Promise<void> => {
  const path = metaPathOf(target.storeDir);
  const data = encodeUtf8(serializeDocMetaFile(docs));
  if (data.length > DOC_META_LIMITS.fileBytes) {
    throw new HrError(
      "invalid_payload",
      `文档元数据表超过 ${String(DOC_META_LIMITS.fileBytes)} 字节上限，拒绝写入`,
    );
  }
  if (prior.exists && prior.corrupt) {
    await backupCorrupt(deps, path);
  }
  await mkdirOrFail(deps, dirname(path));
  await writeAtomic({ path, workspace: target.workspace, data }, deps);
};
