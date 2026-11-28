// This layer: the per-document metadata record (tags + source URL + provenance) and the
// dirty-read normalization + deterministic serialization of the `.hreader/meta.json` table.
// Pure: no IO, no clock. Corruption is file-level (the whole table reads as empty + one
// code-only diagnostic); a write-level violation (oversize tag, bad URL, too many tags) is a
// refusal, never a truncation.

import { jsonObject, looseString, parseJson } from "../schema";

/** Who first wrote the record: HTTP/CLI write `user`, MCP writes `agent`, the clipper reserved. */
export type DocMetaCreator = "user" | "agent" | "clipper";

export const DOC_META_CREATORS: readonly DocMetaCreator[] = ["user", "agent", "clipper"];

export interface DocMetaRecord {
  readonly tags: readonly string[];
  /** Canonical `new URL(...).href` — absent when the doc carries no source link. */
  readonly sourceUrl?: string;
  /** Set once, on first write; later updates never move it. */
  readonly createdBy?: DocMetaCreator;
  /** ISO timestamp of the first write; later updates never move it. */
  readonly savedAt?: string;
}

/** The `setDocMeta` input shape: each key is "only the given fields change" semantics. */
export interface DocMetaPatch {
  /** Whole-list replace (normalized + case-insensitively deduped, first spelling wins). */
  readonly tags?: readonly string[];
  /** Appended after `tags`, same normalization; an already-present tag is a no-op. */
  readonly addTags?: readonly string[];
  /** Removed case-insensitively after `tags`/`addTags`. */
  readonly removeTags?: readonly string[];
  /** `undefined` = keep; `null` = clear; a string must validate via `sourceUrlOf`. */
  readonly sourceUrl?: string | null;
}

/** Hard capacity caps: exceeding one on write is a refusal, on read (file size) a bound. */
export const DOC_META_LIMITS = {
  /** Tags one document may carry. */
  tags: 32,
  /** One tag's length in code points, measured after trim + NFC. */
  tagCodePoints: 64,
  /** `sourceUrl` input length in code points. */
  sourceUrlCodePoints: 2048,
  fileBytes: 5 * 1024 * 1024,
} as const;

export const DOC_META_VERSION = 1;

// ---- tag + url normalization (write side; a violation returns undefined and the caller refuses) ----

/**
 * One tag normalized: trim → NFC → 1..64 code points. `undefined` means the input is not a
 * usable tag (empty after trim, or over the cap) — the caller refuses the whole patch.
 */
export const normalizeTag = (raw: string): string | undefined => {
  const tag = raw.trim().normalize("NFC");
  const length = Array.from(tag).length;
  return length === 0 || length > DOC_META_LIMITS.tagCodePoints ? undefined : tag;
};

/** Case-insensitive dedupe key: lowercasing decides "same tag"; NFC already settled canonics. */
export const foldTag = (tag: string): string => tag.toLowerCase();

/**
 * `sourceUrl` validated: an absolute http/https URL of at most 2048 code points, parsed with
 * `new URL`, and refusing embedded credentials (`user:pass@` — a stored credential would leak
 * into every API/CLI/MCP read of the record). The stored form is the canonical `url.href`.
 * `undefined` means the caller must refuse with `invalid_payload`.
 */
export const sourceUrlOf = (raw: string): string | undefined => {
  if (Array.from(raw).length > DOC_META_LIMITS.sourceUrlCodePoints) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  return url.href;
};

// ---- dirty read ----

/**
 * Prototype-shaped keys are file-level corruption everywhere EXCEPT the docs table's own
 * keyspace: a doc named `__proto__` or `constructor` is a legal workspace file and its meta
 * must land like any other record. Everywhere else (top level, inside a record) such a key
 * is hand-edited dirt — a `__proto__` own property flowing into a merge would silently
 * retarget a prototype instead of landing as data. Explicit worklist (never recursion),
 * same scan as the sidecar; `docKeys` is the docs object itself, checked by identity so
 * only its own key names are exempt — its values (the records) are still scanned.
 */
const DANGEROUS_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

const dangerousKeyOf = (payload: unknown, docKeys: unknown): string | undefined => {
  const pending: unknown[] = [payload];
  for (const node of pending) {
    if (Array.isArray(node)) {
      for (const item of node as readonly unknown[]) pending.push(item);
      continue;
    }
    if (typeof node !== "object" || node === null) continue;
    if (node !== docKeys) {
      for (const key of Object.keys(node)) {
        if (DANGEROUS_KEYS.has(key)) return key;
      }
    }
    for (const value of Object.values(node) as readonly unknown[]) pending.push(value);
  }
  return undefined;
};

export interface DocMetaParse {
  /**
   * Keyed by workspace-relative POSIX path, held as a Map: `__proto__`/`constructor`/
   * `prototype` are legal doc names, so the table never goes through an object's
   * property bag where those names would hit the prototype chain.
   */
  readonly docs: ReadonlyMap<string, DocMetaRecord>;
  /** Code-only diagnostics (`doc_meta_corrupt:<reason>` / `doc_meta_unknown_fields`). */
  readonly diagnostics: readonly string[];
  /** `true` = the whole table is unusable: the next write must back it up before overwriting. */
  readonly corrupt: boolean;
}

const corruptOf = (reason: string): DocMetaParse => ({
  docs: new Map(),
  corrupt: true,
  diagnostics: [`doc_meta_corrupt:${reason}`],
});

/** Record fields that mean something to the reader; anything else lands one diagnostic line. */
const KNOWN_FIELDS = new Set(["tags", "sourceUrl", "createdBy", "savedAt"]);

const isCreator = (raw: string): raw is DocMetaCreator =>
  (DOC_META_CREATORS as readonly string[]).includes(raw);

/**
 * One stored record normalized, or `undefined` when a field is wrong-typed: the contract makes
 * any wrong type file-level corruption (a hand-edited/mistyped table must not answer half of
 * it silently), so the caller reads it as empty instead.
 */
const recordOf = (
  raw: Readonly<Record<string, unknown>>,
): { readonly record?: DocMetaRecord; readonly unknown: readonly string[] } => {
  const unknown = Object.keys(raw).filter((key) => !KNOWN_FIELDS.has(key));
  const tagsRaw = raw["tags"];
  const tags: string[] = [];
  if (tagsRaw !== undefined) {
    if (!Array.isArray(tagsRaw)) return { unknown };
    for (const item of tagsRaw as readonly unknown[]) {
      if (typeof item !== "string") return { unknown };
      tags.push(item);
    }
  }
  const sourceUrl = looseString.parse(raw["sourceUrl"]);
  const savedAt = looseString.parse(raw["savedAt"]);
  const creatorRaw = looseString.parse(raw["createdBy"]);
  if (creatorRaw !== undefined && !isCreator(creatorRaw)) return { unknown };
  return {
    unknown,
    record: {
      tags,
      ...(sourceUrl === undefined ? {} : { sourceUrl }),
      ...(creatorRaw === undefined ? {} : { createdBy: creatorRaw }),
      ...(savedAt === undefined ? {} : { savedAt }),
    },
  };
};

/**
 * File-level corruption reads as empty + exactly one code-only diagnostic. Unlike the sidecar
 * there is no per-record tolerance: `docs` is a keyed table, so a wrong-typed entry is a type
 * violation of the table itself (bad JSON / wrong types / unknown version / dangerous keys).
 */
export const parseDocMetaFile = (text: string): DocMetaParse => {
  const payload = jsonObject.safeParse(parseJson(text));
  if (!payload.success) return corruptOf("not_object");
  const danger = dangerousKeyOf(payload.data, payload.data["docs"]);
  if (danger !== undefined) return corruptOf("dangerous_key");
  if (payload.data["version"] !== DOC_META_VERSION) return corruptOf("bad_version");
  const rawDocs = jsonObject.safeParse(payload.data["docs"]);
  if (!rawDocs.success) return corruptOf("bad_docs");
  // A Map, not an object: `docs.__proto__`/`docs.constructor` are doc names, and only a
  // Map keeps them as data on both the read and the write side.
  const docs = new Map<string, DocMetaRecord>();
  const unknown = new Set<string>();
  for (const [rel, value] of Object.entries(rawDocs.data)) {
    const raw = jsonObject.safeParse(value);
    if (!raw.success) return corruptOf("bad_record");
    const { record, unknown: extra } = recordOf(raw.data);
    if (record === undefined) return corruptOf("bad_record");
    docs.set(rel, record);
    for (const key of extra) unknown.add(key);
  }
  return {
    docs,
    corrupt: false,
    diagnostics: unknown.size === 0 ? [] : ["doc_meta_unknown_fields"],
  };
};

// ---- deterministic write ----

/** Canonical record JSON: fixed field order, optional keys only when present. */
export const docMetaRecordJson = (record: DocMetaRecord): Record<string, unknown> => ({
  tags: [...record.tags],
  ...(record.sourceUrl === undefined ? {} : { sourceUrl: record.sourceUrl }),
  ...(record.createdBy === undefined ? {} : { createdBy: record.createdBy }),
  ...(record.savedAt === undefined ? {} : { savedAt: record.savedAt }),
});

/**
 * Sorted keys + fixed field order + unescaped CJK: the same table produces the same bytes
 * twice. `Object.fromEntries` is the only safe object construction here — it lands a
 * `__proto__` doc name as a real own property where `obj[key] = value` would hit the setter.
 */
export const serializeDocMetaFile = (docs: ReadonlyMap<string, DocMetaRecord>): string =>
  JSON.stringify({
    version: DOC_META_VERSION,
    docs: Object.fromEntries(
      [...docs.entries()]
        .sort(([left], [right]) => (left < right ? -1 : 1))
        .map(([rel, record]) => [rel, docMetaRecordJson(record)]),
    ),
  });
