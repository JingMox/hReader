// This layer: the persisted incremental index under `.hreader/index/search.json` —
// `{ version: 4, docs: { <rel>: { mtimeMs, size, sha, sidecar, meta } }, index: <MiniSearch JSON> }`.
// A query-time update walks the workspace (same pruning as the annotation scan), re-indexes
// docs whose mtime/size/sha moved plus any doc whose sidecar store fingerprint moved —
// annotations change without touching their doc — and any doc whose metadata fingerprint
// moved (tags change without touching bytes too). Deleted docs drop out, and writes go
// through `writeAtomic` under the index's own lock. Diagnostics carry an error code plus a
// workspace-relative name — never an absolute host path.

import MiniSearch, { type Options } from "minisearch";
import { join, relative, resolve, sep } from "node:path";

import type { SidecarAnnotation } from "../annotations/sidecar-model";
import { docMetaRecordJson, type DocMetaRecord } from "../docmeta";
import { annotationPathOf, readSidecarAt, type SidecarFile } from "../io/annotation-store";
import { mkdirOrFail, writeAtomic } from "../io/atomic";
import { decodeUtf8, encodeUtf8 } from "../io/bytes";
import { sha256Hex } from "../io/digest";
import { metaPathOf, readDocMetaAt } from "../io/doc-meta-store";
import { codeOf, isMissing } from "../io/errors";
import type { FileStat, PatchDeps } from "../io/ports";
import { listDocAnnotations, type DocAnnotationEntry } from "../ops/sidecar-ops";
import { extractDocFields, type ExtractedDocFields } from "./extract";
import { isCjkTerm, tokenizeSearchText } from "./tokenize";

export const SEARCH_LIMITS = {
  /** Docs the walk will index; beyond this the answer is a prefix (`truncated`). */
  docs: 5000,
  /** Query length in code points: 1..queryChars. */
  queryChars: 200,
  /** Snippet length in UTF-16 units (never splits a surrogate pair → ≤ 200 code points). */
  snippetChars: 200,
  /** Result count: default `limitDefault`, hard maximum `limitMax`. */
  limitDefault: 20,
  limitMax: 100,
  /** Diagnostics returned; overflow collapses into one trailing line. */
  diagnostics: 100,
} as const;

/** Index file, relative to the workspace root — the same value feeds the lock-key hash. */
export const INDEX_REL = ".hreader/index/search.json";
const INDEX_VERSION = 4;

/** Same skips as `ops/annotation-scan.ts`: hreader's own store plus the two giant dirs. */
const SKIP_DIRS: ReadonlySet<string> = new Set([".hreader", ".git", "node_modules"]);

const HTML_SUFFIX = /\.(?:html|htm)$/iu;

/** One library entry: the doc itself, or one annotation of it. */
interface IndexEntry {
  readonly id: string;
  readonly path: string;
  readonly kind: "doc" | "annotation";
  readonly title?: string;
  readonly headings?: string;
  readonly body?: string;
  /** The owning doc's title on annotation entries: stored for display, never indexed. */
  readonly docTitle?: string;
  readonly annotationId?: string;
  readonly annotation?: string;
  /** Which store an annotation entry came from — the sidecar-only refresh drops by it. */
  readonly source?: "meta" | "sidecar";
  /** The doc's tags joined into the indexed `tags` field (doc entries only). */
  readonly tags?: string;
  /** The doc's verbatim tag list — stored so a hit can echo it; never indexed. */
  readonly tagList?: readonly string[];
}

const FIELD_BOOSTS = { title: 3, headings: 2, tags: 2, body: 1, annotation: 1 } as const;

const MINI_OPTIONS: Options<IndexEntry> = {
  // Annotation entries index `annotation` alone — a title query must not echo every
  // annotation of a matching doc (their doc title rides along as `docTitle` instead). The
  // `tags` field exists only on doc entries: a tag query lands on the doc row itself.
  fields: ["title", "headings", "body", "annotation", "tags"],
  // `title` rides along for display; `annotation` is the snippet source for annotation hits;
  // `tags` is the snippet source for tag hits and `tagList` echoes the list verbatim.
  storeFields: [
    "path",
    "kind",
    "title",
    "docTitle",
    "annotationId",
    "annotation",
    "source",
    "tags",
    "tagList",
  ],
  tokenize: tokenizeSearchText,
  searchOptions: {
    // Prefix only on ≥2-code-point terms: 流* would hit every 流水/流式 token and bury
    // exact recall under noise; a single character must match a token exactly.
    prefix: (term) => Array.from(term).length >= 2,
    // Latin terms tolerate a 0.2 edit distance; CJK terms never go fuzzy (see tokenize.ts).
    fuzzy: (term) => (isCjkTerm(term) ? false : 0.2),
    boost: FIELD_BOOSTS,
  },
};

type SearchIndex = MiniSearch<IndexEntry>;

const newIndex = (): SearchIndex => new MiniSearch<IndexEntry>(MINI_OPTIONS);

/**
 * `\u0000` separates id parts: neither a filesystem path nor an `an-<hex>` annotation id can
 * contain it, so `doc\0<rel>` and `an\0<rel>\0<anId>` are unique by construction.
 */
const docEntryIdOf = (rel: string): string => `doc\u0000${rel}`;

const annotationEntryIdOf = (rel: string, annotationId: string): string =>
  `an\u0000${rel}\u0000${annotationId}`;

/** The indexed (and stored) annotation text: `note + exact`, per the design contract. */
const annotationTextOf = (annotation: SidecarAnnotation): string =>
  [annotation.note, annotation.anchor.exact].filter((text) => text !== "").join("\n");

const entriesOf = (
  rel: string,
  fields: ExtractedDocFields,
  annotations: readonly DocAnnotationEntry[],
  tags: readonly string[],
): readonly IndexEntry[] => [
  {
    id: docEntryIdOf(rel),
    path: rel,
    kind: "doc",
    title: fields.title,
    headings: fields.headings,
    body: fields.body,
    ...(tags.length === 0 ? {} : { tags: tags.join(" "), tagList: [...tags] }),
  },
  ...annotations.map((entry): IndexEntry => ({
    id: annotationEntryIdOf(rel, entry.annotation.id),
    path: rel,
    kind: "annotation",
    docTitle: fields.title,
    annotationId: entry.annotation.id,
    annotation: annotationTextOf(entry.annotation),
    source: entry.source,
  })),
];

// ---- diagnostics: code + workspace-relative name only ----

export interface SearchBucket {
  readonly diagnostics: string[];
  /** Workspace roots (lexical + realpath) folded out of every echoed message. */
  readonly roots: readonly string[];
  /** Diagnostics dropped past the cap, folded into one trailing summary line. */
  dropped: number;
  truncated: boolean;
}

export const newSearchBucket = (workspace: string, workspaceReal: string): SearchBucket => ({
  diagnostics: [],
  roots: [...new Set([resolve(workspace), workspaceReal])],
  dropped: 0,
  truncated: false,
});

/** A workspace-absolute path embedded in a diagnostic folds to `rel`-only form. */
const elidedOf = (message: string, roots: readonly string[]): string =>
  [...roots]
    .sort((left, right) => right.length - left.length)
    .reduce((text, root) => {
      if (root === "/") return text;
      const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return text.replace(new RegExp(`${escaped}(?:[/\\\\]|$)`, "g"), "");
    }, message);

/** Bounded + folded: one diagnostic line carries a code and a `rel`-name, never an absolute path. */
export const pushSearchDiagnostic = (bucket: SearchBucket, diagnostic: string): void => {
  if (bucket.diagnostics.length >= SEARCH_LIMITS.diagnostics) {
    bucket.dropped += 1;
    return;
  }
  bucket.diagnostics.push(elidedOf(diagnostic, bucket.roots));
};

export const codeNameOf = (error: unknown): string => {
  const code = codeOf(error);
  return typeof code === "string" && code !== "" ? code : "internal";
};

// ---- the walk ----

interface Walked {
  readonly absolute: string;
  readonly mtimeMs: number;
  readonly size: number;
}

const posixRelOf = (workspaceReal: string, absolute: string): string =>
  relative(workspaceReal, absolute).split(sep).join("/");

/** BFS over the real workspace root; symlinks are never followed (they may point outside). */
const walkSearchDocs = async (
  workspaceReal: string,
  deps: PatchDeps,
  bucket: SearchBucket,
): Promise<readonly Walked[]> => {
  const docs: Walked[] = [];
  const queue: string[] = [workspaceReal];
  for (;;) {
    const dir = queue.shift();
    if (dir === undefined) return docs;
    let names: readonly string[];
    try {
      names = await deps.fs.readdir(dir);
    } catch (error: unknown) {
      pushSearchDiagnostic(
        bucket,
        `目录不可读：${posixRelOf(workspaceReal, dir)}（${codeNameOf(error)}）`,
      );
      continue;
    }
    for (const name of [...names].sort()) {
      const absolute = join(dir, name);
      let stat: FileStat;
      try {
        stat = await deps.fs.lstat(absolute);
      } catch (error: unknown) {
        pushSearchDiagnostic(
          bucket,
          `条目不可读：${posixRelOf(workspaceReal, absolute)}（${codeNameOf(error)}）`,
        );
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isFile()) {
        if (!HTML_SUFFIX.test(name)) continue;
        if (docs.length >= SEARCH_LIMITS.docs) {
          bucket.truncated = true;
          pushSearchDiagnostic(
            bucket,
            `文档数超过 ${String(SEARCH_LIMITS.docs)} 上限，只索引前 ${String(SEARCH_LIMITS.docs)} 个`,
          );
          return docs;
        }
        docs.push({ absolute, mtimeMs: stat.mtimeMs, size: stat.size });
      } else if (!SKIP_DIRS.has(name)) {
        queue.push(absolute);
      }
    }
  }
};

// ---- persistence ----

/** The sidecar store's `{mtimeMs, size}` — `null` when the doc has no sidecar file. */
interface SidecarFingerprint {
  readonly mtimeMs: number;
  readonly size: number;
}

interface DocRecord {
  readonly mtimeMs: number;
  readonly size: number;
  readonly sha: string;
  /**
   * Fingerprint of `<storeDir>/annotations/<sha1(rel)>.json`: sidecar annotations mutate
   * without touching the doc, so this is what makes their adds/resolves/deletes visible.
   */
  readonly sidecar: SidecarFingerprint | null;
  /**
   * sha256 of the doc's canonical meta-table record JSON, `null` when it has none: tags
   * mutate without touching the doc, so this is what makes tag edits visible.
   */
  readonly meta: string | null;
}

interface LoadedIndex {
  readonly mini: SearchIndex;
  readonly docs: Map<string, DocRecord>;
  /** Anything but a clean load — including a missing file — lands true so the writer heals it. */
  readonly rebuilt: boolean;
}

const freshIndex = (rebuilt: boolean): LoadedIndex => ({
  mini: newIndex(),
  docs: new Map(),
  rebuilt,
});

/** `null` (no sidecar), a fingerprint, or `undefined` (malformed → the whole record is dropped). */
const sidecarFingerprintOf = (value: unknown): SidecarFingerprint | null | undefined => {
  if (value === null) return null;
  if (typeof value !== "object") return undefined;
  const mtimeMs: unknown = Reflect.get(value, "mtimeMs");
  const size: unknown = Reflect.get(value, "size");
  if (typeof mtimeMs !== "number" || !Number.isFinite(mtimeMs)) return undefined;
  if (typeof size !== "number" || !Number.isFinite(size)) return undefined;
  return { mtimeMs, size };
};

const docRecordOf = (value: unknown): DocRecord | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const mtimeMs: unknown = Reflect.get(value, "mtimeMs");
  const size: unknown = Reflect.get(value, "size");
  const sha: unknown = Reflect.get(value, "sha");
  const sidecar = sidecarFingerprintOf(Reflect.get(value, "sidecar"));
  const meta: unknown = Reflect.get(value, "meta");
  if (typeof mtimeMs !== "number" || !Number.isFinite(mtimeMs)) return undefined;
  if (typeof size !== "number" || !Number.isFinite(size)) return undefined;
  if (typeof sha !== "string") return undefined;
  if (sidecar === undefined) return undefined;
  if (typeof meta !== "string" && meta !== null) return undefined;
  return { mtimeMs, size, sha, sidecar, meta };
};

const REBUILT_DIAGNOSTIC = "搜索索引已损坏或版本不兼容，已全量重建";

/**
 * Missing file = first run (no diagnostic). Unreadable bytes, bad JSON, wrong version/shape,
 * or a MiniSearch payload it refuses all collapse to a full rebuild with one diagnostic —
 * never a crash.
 */
const loadIndex = async (
  indexPath: string,
  deps: PatchDeps,
  bucket: SearchBucket,
): Promise<LoadedIndex> => {
  let text: string;
  try {
    text = decodeUtf8(await deps.fs.readFile(indexPath), indexPath);
  } catch (error: unknown) {
    if (isMissing(error)) return freshIndex(true);
    pushSearchDiagnostic(bucket, `搜索索引不可读（${codeNameOf(error)}），已全量重建`);
    return freshIndex(true);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    pushSearchDiagnostic(bucket, REBUILT_DIAGNOSTIC);
    return freshIndex(true);
  }
  if (typeof parsed !== "object" || parsed === null) {
    pushSearchDiagnostic(bucket, REBUILT_DIAGNOSTIC);
    return freshIndex(true);
  }
  const version: unknown = Reflect.get(parsed, "version");
  const docs: unknown = Reflect.get(parsed, "docs");
  const index: unknown = Reflect.get(parsed, "index");
  if (
    version !== INDEX_VERSION ||
    typeof docs !== "object" ||
    docs === null ||
    index === undefined
  ) {
    pushSearchDiagnostic(bucket, REBUILT_DIAGNOSTIC);
    return freshIndex(true);
  }
  let mini: SearchIndex;
  try {
    mini = MiniSearch.loadJSON(JSON.stringify(index), MINI_OPTIONS);
  } catch {
    pushSearchDiagnostic(bucket, REBUILT_DIAGNOSTIC);
    return freshIndex(true);
  }
  const records = new Map<string, DocRecord>();
  for (const [rel, value] of Object.entries(docs)) {
    const record = docRecordOf(value);
    if (record !== undefined) records.set(rel, record);
  }
  return { mini, docs: records, rebuilt: false };
};

/** All index ids claiming one of `paths`: annotations share the doc's `path`, so drop is by path. */
const entryIdsFor = (mini: SearchIndex, paths: ReadonlySet<string>): readonly string[] => {
  const ids: string[] = [];
  for (const result of mini.search(MiniSearch.wildcard)) {
    const path = result["path"] as unknown;
    if (typeof path === "string" && paths.has(path)) ids.push(String(result.id));
  }
  return ids;
};

// ---- sidecar freshness ----

const sidecarPathOf = (workspaceReal: string, rel: string): string =>
  annotationPathOf(join(workspaceReal, ".hreader"), rel);

/**
 * `{mtimeMs, size}` of the doc's sidecar store file; `null` when absent. A stat failure other
 * than ENOENT reports one diagnostic and reads as absent — the refresh that follows will hit
 * the same failure through `readSidecarAt` and report the read side too.
 */
const liveSidecarFingerprint = async (
  workspaceReal: string,
  rel: string,
  deps: PatchDeps,
  bucket: SearchBucket,
): Promise<SidecarFingerprint | null> => {
  try {
    const stat = await deps.fs.lstat(sidecarPathOf(workspaceReal, rel));
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch (error: unknown) {
    if (isMissing(error)) return null;
    pushSearchDiagnostic(bucket, `文档 ${rel} 的批注侧车：${codeNameOf(error)}`);
    return null;
  }
};

/** `undefined` (no trustworthy prior record) counts as changed: the doc takes the full path. */
const sameSidecar = (
  prev: SidecarFingerprint | null | undefined,
  next: SidecarFingerprint | null,
): boolean =>
  prev !== undefined &&
  (prev === null
    ? next === null
    : next !== null && prev.mtimeMs === next.mtimeMs && prev.size === next.size);

/**
 * The whole `.hreader/meta.json` table, read once per update (one file feeds every doc's
 * fingerprint). `undefined` means the read itself failed — per-doc fingerprints then keep
 * their prior values, the same conservative hold a failed sidecar read takes.
 */
const liveMetaTable = async (
  workspaceReal: string,
  deps: PatchDeps,
  bucket: SearchBucket,
): Promise<ReadonlyMap<string, DocMetaRecord> | undefined> => {
  try {
    const file = await readDocMetaAt(metaPathOf(join(workspaceReal, ".hreader")), deps);
    for (const diagnostic of file.diagnostics) pushSearchDiagnostic(bucket, diagnostic);
    return file.docs;
  } catch (error: unknown) {
    pushSearchDiagnostic(bucket, `文档元数据表：${codeNameOf(error)}`);
    return undefined;
  }
};

/** The fingerprint of one doc's meta record: stable bytes of the canonical field order. */
const metaFingerprintOf = (record: DocMetaRecord | undefined): string | null =>
  record === undefined ? null : sha256Hex(encodeUtf8(JSON.stringify(docMetaRecordJson(record))));

/** Ids of `rel`'s sidecar-derived annotation entries plus the stored doc title, in one scan. */
const sidecarIndexStateOf = (
  mini: SearchIndex,
  rel: string,
): { readonly ids: readonly string[]; readonly docTitle: string } => {
  const ids: string[] = [];
  let docTitle = "";
  for (const result of mini.search(MiniSearch.wildcard)) {
    if (result["path"] !== rel) continue;
    if (result.id === docEntryIdOf(rel)) {
      const title: unknown = result["title"];
      if (typeof title === "string") docTitle = title;
    } else if (result["kind"] === "annotation" && result["source"] !== "meta") {
      ids.push(String(result.id));
    }
  }
  return { ids, docTitle };
};

/**
 * Re-index only `rel`'s sidecar-sourced annotation entries — the doc bytes never move, so its
 * doc entry and its hr-meta annotation entries stay as-is. Returns false (and keeps the old
 * fingerprint) when the store itself could not be read, so the next query retries.
 */
const refreshSidecarEntries = async (
  workspaceReal: string,
  rel: string,
  mini: SearchIndex,
  deps: PatchDeps,
  bucket: SearchBucket,
): Promise<boolean> => {
  let file: SidecarFile;
  try {
    file = await readSidecarAt(sidecarPathOf(workspaceReal, rel), rel, deps);
  } catch (error: unknown) {
    pushSearchDiagnostic(bucket, `文档 ${rel} 的批注：${codeNameOf(error)}`);
    return false;
  }
  for (const diagnostic of file.diagnostics) pushSearchDiagnostic(bucket, diagnostic);
  const prior = sidecarIndexStateOf(mini, rel);
  if (prior.ids.length > 0) mini.discardAll(prior.ids);
  const fresh = file.annotations
    .filter((annotation) => {
      // hr-meta wins an id collision — same rule as listDocAnnotations; the surviving
      // meta entry is still in the index (its doc bytes never changed).
      if (!mini.has(annotationEntryIdOf(rel, annotation.id))) return true;
      pushSearchDiagnostic(
        bucket,
        `批注 ${annotation.id} 同时存在于 hr-meta 与侧车，以 hr-meta 为准，已忽略侧车条目`,
      );
      return false;
    })
    .map((annotation): IndexEntry => ({
      id: annotationEntryIdOf(rel, annotation.id),
      path: rel,
      kind: "annotation",
      docTitle: prior.docTitle,
      annotationId: annotation.id,
      annotation: annotationTextOf(annotation),
      source: "sidecar",
    }));
  if (fresh.length > 0) mini.addAll(fresh);
  return true;
};

interface PendingDoc {
  readonly rel: string;
  readonly fields: ExtractedDocFields;
  readonly annotations: readonly DocAnnotationEntry[];
  readonly tags: readonly string[];
}

interface UpdatedIndex {
  readonly mini: SearchIndex;
  readonly truncated: boolean;
}

/**
 * The query-time incremental update. `workspace` is the caller's spelling (annotation listing
 * resolves through it); `workspaceReal` is where the walk and the index file live. A changed
 * doc's old entries drop by path before the new ones land, so an edited doc can never answer
 * for stale text.
 */
export const updateIndex = async (
  input: {
    readonly workspace: string;
    readonly workspaceReal: string;
    readonly indexPath: string;
  },
  deps: PatchDeps,
  bucket: SearchBucket,
): Promise<UpdatedIndex> => {
  const state = await loadIndex(input.indexPath, deps, bucket);
  const walked = await walkSearchDocs(input.workspaceReal, deps, bucket);
  const metaTable = await liveMetaTable(input.workspaceReal, deps, bucket);
  const records = new Map<string, DocRecord>();
  const drops = new Set<string>();
  const adds: PendingDoc[] = [];
  let changed = state.rebuilt;
  for (const doc of walked) {
    const rel = posixRelOf(input.workspaceReal, doc.absolute);
    const prev = state.docs.get(rel);
    // The sidecar store fingerprints every doc — annotations mutate without touching it.
    const sidecar = await liveSidecarFingerprint(input.workspaceReal, rel, deps, bucket);
    const storeMoved = !sameSidecar(prev?.sidecar, sidecar);
    // Same for the meta table: a tag edit is invisible in mtime/size/sha, so the record
    // hash is what detects it. A failed table read holds the prior fingerprint.
    const metaRecord = metaTable?.get(rel);
    const meta = metaTable === undefined ? (prev?.meta ?? null) : metaFingerprintOf(metaRecord);
    const metaMoved = prev !== undefined && prev.meta !== meta;
    if (prev?.mtimeMs === doc.mtimeMs && prev.size === doc.size && !metaMoved) {
      if (storeMoved) {
        if (await refreshSidecarEntries(input.workspaceReal, rel, state.mini, deps, bucket)) {
          records.set(rel, { ...prev, sidecar });
          changed = true;
          continue;
        }
      }
      records.set(rel, prev);
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await deps.fs.readFile(doc.absolute);
    } catch (error: unknown) {
      pushSearchDiagnostic(bucket, `文档 ${rel}：${codeNameOf(error)}`);
      if (prev !== undefined) records.set(rel, prev);
      continue;
    }
    const sha = sha256Hex(bytes);
    if (prev?.sha === sha && !metaMoved) {
      if (storeMoved) {
        if (await refreshSidecarEntries(input.workspaceReal, rel, state.mini, deps, bucket)) {
          records.set(rel, { mtimeMs: doc.mtimeMs, size: doc.size, sha, sidecar, meta });
          changed = true;
          continue;
        }
        records.set(rel, {
          mtimeMs: doc.mtimeMs,
          size: doc.size,
          sha,
          sidecar: prev.sidecar,
          meta,
        });
        changed = true;
        continue;
      }
      records.set(rel, { mtimeMs: doc.mtimeMs, size: doc.size, sha, sidecar, meta });
      changed = true;
      continue;
    }
    let fields: ExtractedDocFields;
    try {
      fields = extractDocFields(decodeUtf8(bytes, rel));
    } catch (error: unknown) {
      pushSearchDiagnostic(bucket, `文档 ${rel}：${codeNameOf(error)}`);
      if (prev !== undefined) records.set(rel, prev);
      continue;
    }
    const listed = await listDocAnnotations({ workspace: input.workspace, file: rel }, deps).catch(
      (error: unknown) => {
        pushSearchDiagnostic(bucket, `文档 ${rel} 的批注：${codeNameOf(error)}`);
        return undefined;
      },
    );
    if (listed !== undefined) {
      for (const diagnostic of listed.diagnostics) pushSearchDiagnostic(bucket, diagnostic);
    }
    drops.add(rel);
    adds.push({
      rel,
      fields,
      annotations: listed?.annotations ?? [],
      tags: metaRecord?.tags ?? [],
    });
    records.set(rel, { mtimeMs: doc.mtimeMs, size: doc.size, sha, sidecar, meta });
    changed = true;
  }
  // Anything recorded but no longer walked is a deleted doc: its entries leave the index.
  for (const rel of state.docs.keys()) {
    if (!records.has(rel)) {
      drops.add(rel);
      changed = true;
    }
  }
  if (drops.size > 0) {
    state.mini.discardAll(entryIdsFor(state.mini, drops));
  }
  for (const pending of adds) {
    state.mini.addAll(entriesOf(pending.rel, pending.fields, pending.annotations, pending.tags));
  }
  if (!changed) return { mini: state.mini, truncated: bucket.truncated };
  try {
    await mkdirOrFail(deps, join(input.workspaceReal, ".hreader", "index"));
    const envelope = JSON.stringify({
      version: INDEX_VERSION,
      docs: Object.fromEntries(records),
      index: state.mini.toJSON(),
    });
    await writeAtomic(
      { path: input.indexPath, workspace: input.workspaceReal, data: encodeUtf8(envelope) },
      deps,
    );
  } catch (error: unknown) {
    // An unwritable index dir still answers from the fresh in-memory index — one diagnostic.
    pushSearchDiagnostic(bucket, `搜索索引写入失败（${codeNameOf(error)}）`);
  }
  return { mini: state.mini, truncated: bucket.truncated };
};
