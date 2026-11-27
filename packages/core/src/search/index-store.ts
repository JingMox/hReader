// This layer: the persisted incremental index under `.hreader/index/search.json` —
// `{ version: 1, docs: { <rel>: { mtimeMs, size, sha } }, index: <MiniSearch JSON> }`.
// A query-time update walks the workspace (same pruning as the annotation scan), re-indexes
// only docs whose mtime/size/sha moved, drops deleted docs, and writes through `writeAtomic`
// under the index's own lock. Diagnostics carry an error code plus a workspace-relative name —
// never an absolute host path.

import MiniSearch, { type Options } from "minisearch";
import { join, relative, resolve, sep } from "node:path";

import { mkdirOrFail, writeAtomic } from "../io/atomic";
import { decodeUtf8, encodeUtf8 } from "../io/bytes";
import { sha256Hex } from "../io/digest";
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
const INDEX_VERSION = 1;

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
}

const FIELD_BOOSTS = { title: 3, headings: 2, body: 1, annotation: 1 } as const;

const MINI_OPTIONS: Options<IndexEntry> = {
  // Annotation entries index `annotation` alone — a title query must not echo every
  // annotation of a matching doc (their doc title rides along as `docTitle` instead).
  fields: ["title", "headings", "body", "annotation"],
  // `title` rides along for display; `annotation` is the snippet source for annotation hits.
  storeFields: ["path", "kind", "title", "docTitle", "annotationId", "annotation"],
  tokenize: tokenizeSearchText,
  searchOptions: {
    prefix: true,
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
const annotationTextOf = (entry: DocAnnotationEntry): string =>
  [entry.annotation.note, entry.annotation.anchor.exact].filter((text) => text !== "").join("\n");

const entriesOf = (
  rel: string,
  fields: ExtractedDocFields,
  annotations: readonly DocAnnotationEntry[],
): readonly IndexEntry[] => [
  {
    id: docEntryIdOf(rel),
    path: rel,
    kind: "doc",
    title: fields.title,
    headings: fields.headings,
    body: fields.body,
  },
  ...annotations.map((entry): IndexEntry => ({
    id: annotationEntryIdOf(rel, entry.annotation.id),
    path: rel,
    kind: "annotation",
    docTitle: fields.title,
    annotationId: entry.annotation.id,
    annotation: annotationTextOf(entry),
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

interface DocRecord {
  readonly mtimeMs: number;
  readonly size: number;
  readonly sha: string;
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

const docRecordOf = (value: unknown): DocRecord | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const mtimeMs: unknown = Reflect.get(value, "mtimeMs");
  const size: unknown = Reflect.get(value, "size");
  const sha: unknown = Reflect.get(value, "sha");
  if (typeof mtimeMs !== "number" || !Number.isFinite(mtimeMs)) return undefined;
  if (typeof size !== "number" || !Number.isFinite(size)) return undefined;
  if (typeof sha !== "string") return undefined;
  return { mtimeMs, size, sha };
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

interface PendingDoc {
  readonly rel: string;
  readonly fields: ExtractedDocFields;
  readonly annotations: readonly DocAnnotationEntry[];
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
  const records = new Map<string, DocRecord>();
  const drops = new Set<string>();
  const adds: PendingDoc[] = [];
  let changed = state.rebuilt;
  for (const doc of walked) {
    const rel = posixRelOf(input.workspaceReal, doc.absolute);
    const prev = state.docs.get(rel);
    if (prev?.mtimeMs === doc.mtimeMs && prev.size === doc.size) {
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
    if (prev?.sha === sha) {
      records.set(rel, { mtimeMs: doc.mtimeMs, size: doc.size, sha });
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
    adds.push({ rel, fields, annotations: listed?.annotations ?? [] });
    records.set(rel, { mtimeMs: doc.mtimeMs, size: doc.size, sha });
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
    state.mini.addAll(entriesOf(pending.rel, pending.fields, pending.annotations));
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
