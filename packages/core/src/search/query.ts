// This layer: `searchLibrary` — validate the query, run the incremental index update under
// the index lock, then score + snippet the top results. Everything the wire carries is
// workspace-relative; diagnostics never embed an absolute host path.

import { join } from "node:path";

import type { SearchResult as MiniSearchResult } from "minisearch";

import { HrError } from "../hr-error";
import { decodeUtf8, readBytes } from "../io/bytes";
import { sha1Hex } from "../io/digest";
import { failureOf } from "../io/errors";
import { runLocked } from "../io/lock";
import { resolveTarget } from "../io/paths";
import type { PatchDeps } from "../io/ports";
import { extractDocFields } from "./extract";
import {
  INDEX_REL,
  SEARCH_LIMITS,
  codeNameOf,
  newSearchBucket,
  pushSearchDiagnostic,
  updateIndex,
  type SearchBucket,
} from "./index-store";
import { snippetOf } from "./snippet";

/** Other processes may be mid-rebuild when a query arrives: waits are bounded, not instant. */
const INDEX_LOCK_WAIT_MS = 30_000;

export interface SearchInput {
  /** Absolute workspace root (same contract as `resolveTarget`'s `workspace`). */
  readonly workspace: string;
  /** 1..`SEARCH_LIMITS.queryChars` code points. */
  readonly query: string;
  /** Result cap: integer 1..`SEARCH_LIMITS.limitMax`, default `SEARCH_LIMITS.limitDefault`. */
  readonly limit?: number | undefined;
}

export interface SearchHit {
  /** Workspace-relative POSIX path of the document owning the hit. */
  readonly path: string;
  /** The document's indexed title (`""` when it has none). */
  readonly title: string;
  readonly kind: "doc" | "annotation";
  /** Present only on `kind === "annotation"`. */
  readonly annotationId?: string;
  readonly score: number;
  /** ≤ `SEARCH_LIMITS.snippetChars` code units around the first match. */
  readonly snippet: string;
  /** `[start, end)` pairs indexing into `snippet`. */
  readonly highlights: readonly (readonly [number, number])[];
}

export interface LibrarySearchResult {
  readonly results: readonly SearchHit[];
  /** All hits the query produced, before `limit` cut the visible list down. */
  readonly total: number;
  /**
   * How the terms combined: `"and"` when the intersection answered, `"or"` when it came
   * back empty and the union produced the list (single-term queries always read `"and"`).
   */
  readonly combine: "and" | "or";
  /** The index is a bounded prefix of the library (doc cap or dropped diagnostics). */
  readonly truncated: boolean;
  readonly diagnostics: readonly string[];
}

const assertQuery = (query: string): void => {
  const length = Array.from(query).length;
  if (length === 0 || length > SEARCH_LIMITS.queryChars) {
    throw new HrError(
      "invalid_request",
      `查询词必须是 1..${String(SEARCH_LIMITS.queryChars)} 个码点（当前 ${String(length)} 个）`,
    );
  }
};

const limitOf = (limit: number | undefined): number => {
  if (limit === undefined) return SEARCH_LIMITS.limitDefault;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SEARCH_LIMITS.limitMax) {
    throw new HrError(
      "invalid_request",
      `limit 必须是 1..${String(SEARCH_LIMITS.limitMax)} 的整数`,
    );
  }
  return limit;
};

/** Fields in boost order — the snippet comes from the strongest field the hit matched. */
const FIELD_PRIORITY = ["title", "headings", "body", "annotation"] as const;

type SnippetField = (typeof FIELD_PRIORITY)[number];

interface StoredHit {
  readonly path?: unknown;
  readonly kind?: unknown;
  readonly title?: unknown;
  readonly docTitle?: unknown;
  readonly annotationId?: unknown;
  readonly annotation?: unknown;
  readonly score: number;
  readonly match: Record<string, string[]>;
}

/**
 * `match` is `{documentTerm: fields}`: collect the document terms that matched in `field`.
 * Those terms are the literal index keys — lowercased tokens that `searchTokensOf` re-derives
 * from the snippet source byte-for-byte.
 */
const termsInField = (match: Record<string, string[]>, field: string): readonly string[] =>
  Object.entries(match)
    .filter((entry) => entry[1].includes(field))
    .map((entry) => entry[0]);

/**
 * Doc hits re-read the file: the body (the only un-stored field) is too large to persist, and
 * re-reading also keeps title/headings snippets honest when the file moved since the update.
 * Annotation hits snippet from the stored `annotation` text — the same string that was indexed.
 * A doc that vanished in the window reports one diagnostic and an empty snippet, never a crash.
 */
const sourceTextOf = async (
  input: SearchInput,
  hit: StoredHit,
  field: SnippetField,
  deps: PatchDeps,
  bucket: SearchBucket,
): Promise<string> => {
  if (hit.kind === "annotation") {
    return typeof hit.annotation === "string" ? hit.annotation : "";
  }
  const path = typeof hit.path === "string" ? hit.path : "";
  try {
    const target = await resolveTarget({ workspace: input.workspace, file: path }, deps.fs);
    const html = decodeUtf8(await readBytes(deps.fs, target.realPath), target.realPath);
    const fields = extractDocFields(html);
    return field === "title" ? fields.title : field === "headings" ? fields.headings : fields.body;
  } catch (error: unknown) {
    pushSearchDiagnostic(bucket, `文档 ${path}：${codeNameOf(error)}`);
    return "";
  }
};

const hitOf = async (
  input: SearchInput,
  result: MiniSearchResult,
  deps: PatchDeps,
  bucket: SearchBucket,
): Promise<SearchHit> => {
  const hit = result as MiniSearchResult & StoredHit;
  const matchedFields = new Set(Object.values(hit.match).flat());
  let field: SnippetField = "body";
  for (const candidate of FIELD_PRIORITY) {
    if (matchedFields.has(candidate)) {
      field = candidate;
      break;
    }
  }
  const snippet = snippetOf(
    await sourceTextOf(input, hit, field, deps, bucket),
    termsInField(hit.match, field),
  );
  const kind = hit.kind === "annotation" ? "annotation" : "doc";
  const annotationId =
    kind === "annotation" && typeof hit.annotationId === "string" ? hit.annotationId : undefined;
  const title =
    typeof hit.title === "string"
      ? hit.title
      : typeof hit.docTitle === "string"
        ? hit.docTitle
        : "";
  return {
    path: typeof hit.path === "string" ? hit.path : "",
    title,
    kind,
    ...(annotationId === undefined ? {} : { annotationId }),
    score: hit.score,
    snippet: snippet.text,
    highlights: snippet.highlights,
  };
};

/**
 * Full-text search over the whole workspace library (documents + annotations). The update
 * scan and the search both run inside the index lock: concurrent searches across processes
 * serialize on it, and an unchanged library produces no write at all.
 */
export const searchLibrary = async (
  input: SearchInput,
  deps: PatchDeps,
): Promise<LibrarySearchResult> => {
  assertQuery(input.query);
  const limit = limitOf(input.limit);
  let workspaceReal: string;
  try {
    workspaceReal = await deps.fs.realpath(input.workspace);
  } catch (error: unknown) {
    throw failureOf("realpath", input.workspace, error);
  }
  const lockPath = join(workspaceReal, ".hreader", "locks", `${sha1Hex(INDEX_REL)}.lock`);
  const indexPath = join(workspaceReal, INDEX_REL);
  return await runLocked({ lockPath }, deps, { lockTimeoutMs: INDEX_LOCK_WAIT_MS }, async () => {
    const bucket = newSearchBucket(input.workspace, workspaceReal);
    const { mini, truncated } = await updateIndex(
      { workspace: input.workspace, workspaceReal, indexPath },
      deps,
      bucket,
    );
    // Multi-term queries intersect first; only an empty AND falls back to the union so a
    // partially-matching doc still answers (combine reports which side produced the list).
    let found = mini.search(input.query, {
      combineWith: "AND",
    }) as readonly MiniSearchResult[];
    let combine: "and" | "or" = "and";
    if (found.length === 0) {
      found = mini.search(input.query);
      combine = "or";
    }
    const results: SearchHit[] = [];
    for (const result of found.slice(0, limit)) {
      results.push(await hitOf(input, result, deps, bucket));
    }
    if (bucket.dropped > 0) {
      bucket.diagnostics.push(`（其余 ${String(bucket.dropped)} 条诊断已省略）`);
    }
    return {
      results,
      total: found.length,
      combine,
      truncated,
      diagnostics: bucket.diagnostics,
    };
  });
};
