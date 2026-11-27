// This layer: `listWorkspaceAnnotations` — a bounded workspace-wide scan for docs carrying
// annotations. Discovery is two-pronged: a `.html`/`.htm` walk (each doc goes through the same
// merged meta+sidecar read as `GET /api/doc/:docId/sidecar`), plus a pass over
// `.hreader/annotations/*.json` records so annotations on docs the walk cannot see (non-HTML
// files, walk-truncated docs) still surface. Store records that point at unreachable or
// mis-keyed paths become diagnostics, never a crash.

import { basename, join, relative, sep } from "node:path";

import type { AnnotationStatus } from "../annotations/model";
import { decodeUtf8 } from "../io/bytes";
import { sha1Hex } from "../io/digest";
import { failureOf, isMissing } from "../io/errors";
import { resolveTarget } from "../io/paths";
import type { FileStat, PatchDeps } from "../io/ports";
import { listDocAnnotations, type DocAnnotationEntry } from "./sidecar-ops";

/** Bounded by contract: the tool result must stay small enough to hand an agent whole. */
export const WORKSPACE_SCAN_LIMITS = {
  /** Docs inspected (walk hits + store-record resolutions each count one). */
  docs: 500,
  /** Entries returned after the status filter. */
  annotations: 1000,
  /** `.hreader/annotations/*.json` files examined. */
  records: 500,
  /** Diagnostics returned; overflow collapses into one trailing line. */
  diagnostics: 100,
} as const;

export type AnnotationStatusFilter = "pending" | "resolved" | "all";

export interface WorkspaceAnnotationsInput {
  /** Absolute workspace root (same contract as `resolveTarget`'s `workspace`). */
  readonly workspace: string;
  readonly status?: AnnotationStatusFilter | undefined;
}

export interface WorkspaceAnnotationEntry extends DocAnnotationEntry {
  /** Workspace-relative POSIX path of the document carrying the annotation. */
  readonly file: string;
}

export interface WorkspaceAnnotationsResult {
  readonly annotations: readonly WorkspaceAnnotationEntry[];
  readonly diagnostics: readonly string[];
  /** How many docs were actually inspected (bounded by `WORKSPACE_SCAN_LIMITS.docs`). */
  readonly docsScanned: number;
  /** Any cap was hit: the answer is a prefix of reality, not the whole of it. */
  readonly truncated: boolean;
}

/** Same skips as `server/watcher.ts`'s INTERNAL_SEGMENTS: hreader's own store plus the two giant dirs a source checkout usually carries. */
const SKIP_DIRS: ReadonlySet<string> = new Set([".hreader", ".git", "node_modules"]);

const HTML_SUFFIX = /\.(?:html|htm)$/iu;

const posixRelOf = (workspaceReal: string, absolute: string): string => {
  const rel = relative(workspaceReal, absolute).split(sep).join("/");
  return rel === "" ? "." : rel;
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface Bucket {
  readonly annotations: WorkspaceAnnotationEntry[];
  readonly diagnostics: string[];
  docsScanned: number;
  /** Diagnostics dropped past the cap, folded into the trailing summary line. */
  dropped: number;
  truncated: boolean;
}

const pushDiagnostic = (bucket: Bucket, diagnostic: string): void => {
  if (bucket.diagnostics.length >= WORKSPACE_SCAN_LIMITS.diagnostics) {
    bucket.dropped += 1;
    return;
  }
  bucket.diagnostics.push(diagnostic);
};

const statusHitOf = (filter: AnnotationStatusFilter, status: AnnotationStatus): boolean =>
  filter === "all" || filter === status;

/** One doc through the merged read: both walk and record discovery funnel here so caps count every inspected doc. */
const collectDoc = async (
  input: WorkspaceAnnotationsInput,
  filter: AnnotationStatusFilter,
  deps: PatchDeps,
  bucket: Bucket,
  file: string,
): Promise<void> => {
  if (bucket.docsScanned >= WORKSPACE_SCAN_LIMITS.docs) {
    bucket.truncated = true;
    return;
  }
  bucket.docsScanned += 1;
  const listed = await listDocAnnotations({ workspace: input.workspace, file }, deps).catch(
    (error: unknown) => {
      pushDiagnostic(bucket, `文档 ${file}：${messageOf(error)}`);
      return undefined;
    },
  );
  if (listed === undefined) return;
  for (const diagnostic of listed.diagnostics) pushDiagnostic(bucket, diagnostic);
  for (const entry of listed.annotations) {
    if (!statusHitOf(filter, entry.annotation.status)) continue;
    if (bucket.annotations.length >= WORKSPACE_SCAN_LIMITS.annotations) {
      bucket.truncated = true;
      return;
    }
    bucket.annotations.push({ ...entry, file });
  }
};

/** BFS over the real workspace root; symlinks are never followed (they may point outside). */
const walkHtmlDocs = async (
  workspaceReal: string,
  deps: PatchDeps,
  bucket: Bucket,
): Promise<readonly string[]> => {
  const docs: string[] = [];
  const queue: string[] = [workspaceReal];
  for (;;) {
    const dir = queue.shift();
    if (dir === undefined) return docs;
    let names: readonly string[];
    try {
      names = await deps.fs.readdir(dir);
    } catch (error: unknown) {
      pushDiagnostic(
        bucket,
        `目录不可读：${posixRelOf(workspaceReal, dir)}（${messageOf(error)}）`,
      );
      continue;
    }
    for (const name of [...names].sort()) {
      const absolute = join(dir, name);
      let stat: FileStat;
      try {
        stat = await deps.fs.lstat(absolute);
      } catch (error: unknown) {
        pushDiagnostic(
          bucket,
          `条目不可读：${posixRelOf(workspaceReal, absolute)}（${messageOf(error)}）`,
        );
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isFile()) {
        if (!HTML_SUFFIX.test(name)) continue;
        if (docs.length >= WORKSPACE_SCAN_LIMITS.docs) {
          bucket.truncated = true;
          return docs;
        }
        docs.push(absolute);
      } else if (!SKIP_DIRS.has(name)) {
        queue.push(absolute);
      }
    }
  }
};

/** The sidecar record's own `path` field is the doc key: extract it loosely so a half-corrupt file still maps. */
const recordPathOf = (text: string): string | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const path: unknown = Reflect.get(value, "path");
  return typeof path === "string" && path.length > 0 ? path : undefined;
};

/** Records whose docs the walk never saw still get their merged read; anything malformed/unreachable is one diagnostic line. */
const scanRecords = async (
  input: WorkspaceAnnotationsInput,
  workspaceReal: string,
  filter: AnnotationStatusFilter,
  covered: Set<string>,
  deps: PatchDeps,
  bucket: Bucket,
): Promise<void> => {
  const dir = join(workspaceReal, ".hreader", "annotations");
  let names: readonly string[];
  try {
    names = await deps.fs.readdir(dir);
  } catch (error: unknown) {
    // A missing store is the normal case (nobody annotated yet), not a diagnostic.
    if (!isMissing(error)) {
      pushDiagnostic(bucket, `批注侧车目录不可读（${messageOf(error)}）`);
    }
    return;
  }
  const records = names.filter((name) => name.endsWith(".json")).sort();
  if (records.length > WORKSPACE_SCAN_LIMITS.records) bucket.truncated = true;
  for (const name of records.slice(0, WORKSPACE_SCAN_LIMITS.records)) {
    const path = join(dir, name);
    let text: string;
    try {
      text = decodeUtf8(await deps.fs.readFile(path), path);
    } catch (error: unknown) {
      pushDiagnostic(bucket, `批注侧车记录 ${name} 不可读（${messageOf(error)}）`);
      continue;
    }
    const claimed = recordPathOf(text);
    if (claimed === undefined) {
      pushDiagnostic(bucket, `批注侧车记录 ${name} 缺少可用的 path 字段`);
      continue;
    }
    let relativePath: string;
    try {
      const target = await resolveTarget({ workspace: input.workspace, file: claimed }, deps.fs);
      relativePath = target.relative;
    } catch (error: unknown) {
      pushDiagnostic(
        bucket,
        `批注侧车记录 ${name} 指向不可达文档 ${claimed}（${messageOf(error)}）`,
      );
      continue;
    }
    // A filename that is not `sha1(path)` is unreachable litter (no read path ever hashes to it): flag, don't read.
    if (sha1Hex(relativePath) !== basename(name, ".json")) {
      pushDiagnostic(
        bucket,
        `批注侧车记录 ${name} 的 path 与文件名不符（指向 ${claimed}），按孤儿记录处理`,
      );
      continue;
    }
    if (covered.has(relativePath)) continue;
    covered.add(relativePath);
    await collectDoc(input, filter, deps, bucket, relativePath);
  }
};

export const listWorkspaceAnnotations = async (
  input: WorkspaceAnnotationsInput,
  deps: PatchDeps,
): Promise<WorkspaceAnnotationsResult> => {
  const filter = input.status ?? "all";
  let workspaceReal: string;
  try {
    workspaceReal = await deps.fs.realpath(input.workspace);
  } catch (error: unknown) {
    throw failureOf("realpath", input.workspace, error);
  }
  const bucket: Bucket = {
    annotations: [],
    diagnostics: [],
    docsScanned: 0,
    dropped: 0,
    truncated: false,
  };
  const covered = new Set<string>();
  for (const absolute of await walkHtmlDocs(workspaceReal, deps, bucket)) {
    const relativePath = posixRelOf(workspaceReal, absolute);
    covered.add(relativePath);
    await collectDoc(input, filter, deps, bucket, relativePath);
  }
  await scanRecords(input, workspaceReal, filter, covered, deps, bucket);
  if (bucket.dropped > 0) {
    bucket.diagnostics.push(`（其余 ${String(bucket.dropped)} 条诊断已省略）`);
  }
  return {
    annotations: bucket.annotations,
    diagnostics: bucket.diagnostics,
    docsScanned: bucket.docsScanned,
    truncated: bucket.truncated,
  };
};
