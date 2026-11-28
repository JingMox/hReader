// This layer: document-metadata ops — `getDocMeta`/`setDocMeta` over the shared
// `.hreader/meta.json` table. Every write resolves the doc target first (the metadata key is
// the doc's canonical workspace-relative path), then read-modify-writes under the table-wide
// lock; none of it ever touches the document's HTML bytes.

import {
  DOC_META_CREATORS,
  DOC_META_LIMITS,
  foldTag,
  normalizeTag,
  sourceUrlOf,
  type DocMetaCreator,
  type DocMetaPatch,
  type DocMetaRecord,
} from "../docmeta";
import { HrError } from "../hr-error";
import { metaLockOf, readDocMetaFile, writeDocMetaFile } from "../io/doc-meta-store";
import { runLocked } from "../io/lock";
import type { PatchOptions, PatchTargetInput } from "../io/contracts";
import { resolveTarget } from "../io/paths";
import type { PatchDeps } from "../io/ports";
import { cutAtCodePoint } from "../text/truncate";

function fail(message: string): never {
  throw new HrError("invalid_payload", message);
}

const EMPTY_META: DocMetaRecord = { tags: [] };

// `unknown` not `DocMetaCreator`: a caller through any/JSON boundary can pass any string, and
// the check must stay a real runtime gate, not a statically-dead comparison.
const creatorOf = (raw: unknown): DocMetaCreator => {
  if (raw === "user" || raw === "agent" || raw === "clipper") return raw;
  fail(`createdBy 只接受 ${DOC_META_CREATORS.join("/")}`);
};

// ---- merge helpers (pure; run inside the lock on the just-read table) ----

/** One caller-supplied list normalized item by item; a bad item refuses the whole patch. */
const tagsOf = (list: readonly string[] | undefined, label: string): readonly string[] => {
  if (list === undefined) return [];
  return list.map((item, index) => {
    if (typeof item !== "string") fail(`${label}[${String(index)}] 不是字符串`);
    const tag = normalizeTag(item);
    if (tag === undefined) {
      fail(
        `标签不合法：${JSON.stringify(cutAtCodePoint(item, 80))}（空白或超过 ${String(DOC_META_LIMITS.tagCodePoints)} 码点）`,
      );
    }
    return tag;
  });
};

/**
 * Tag list after the patch: `tags` replaces wholesale (normalized + case-insensitively
 * deduped, first spelling wins), `addTags` appends what is not already there, `removeTags`
 * filters case-insensitively. The merged list still has to fit the per-doc cap.
 */
const mergeTags = (current: readonly string[], patch: DocMetaPatch): readonly string[] => {
  let next: readonly string[] = current;
  if (patch.tags !== undefined) {
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const tag of tagsOf(patch.tags, "tags")) {
      if (seen.has(foldTag(tag))) continue;
      seen.add(foldTag(tag));
      merged.push(tag);
    }
    next = merged;
  }
  for (const tag of tagsOf(patch.addTags, "addTags")) {
    if (next.some((item) => foldTag(item) === foldTag(tag))) continue;
    next = [...next, tag];
  }
  const drops = new Set(tagsOf(patch.removeTags, "removeTags").map(foldTag));
  if (drops.size > 0) next = next.filter((tag) => !drops.has(foldTag(tag)));
  if (next.length > DOC_META_LIMITS.tags) {
    fail(`标签数 ${String(next.length)} 超过 ${String(DOC_META_LIMITS.tags)} 上限`);
  }
  return next;
};

const mergedSourceUrl = (current: string | undefined, patch: DocMetaPatch): string | undefined => {
  if (patch.sourceUrl === undefined) return current;
  if (patch.sourceUrl === null) return undefined;
  if (typeof patch.sourceUrl !== "string") fail("sourceUrl 必须是字符串或 null");
  const url = sourceUrlOf(patch.sourceUrl);
  if (url === undefined) {
    fail(
      `sourceUrl 不合法：必须是 http/https 绝对 URL（≤${String(DOC_META_LIMITS.sourceUrlCodePoints)} 码点，不接受含凭据）：${JSON.stringify(cutAtCodePoint(patch.sourceUrl, 120))}`,
    );
  }
  return url;
};

/**
 * The record after the patch, or `undefined` = "nothing to store". `undefined` is reachable
 * only when there was no prior record and the patch yields all-empty fields (e.g. removeTags
 * on a doc that never had meta): that is a `changed:false`, not an empty record on disk.
 * Provenance fields are first-write facts: `createdBy`/`savedAt` are set only when absent.
 */
const mergedOf = (
  current: DocMetaRecord | undefined,
  patch: DocMetaPatch,
  by: DocMetaCreator,
  now: string,
): DocMetaRecord | undefined => {
  if (
    patch.tags === undefined &&
    patch.addTags === undefined &&
    patch.removeTags === undefined &&
    patch.sourceUrl === undefined
  ) {
    return current;
  }
  const tags = mergeTags(current?.tags ?? [], patch);
  const sourceUrl = mergedSourceUrl(current?.sourceUrl, patch);
  if (current === undefined && tags.length === 0 && sourceUrl === undefined) return undefined;
  return {
    tags,
    ...(sourceUrl === undefined ? {} : { sourceUrl }),
    createdBy: current?.createdBy ?? by,
    savedAt: current?.savedAt ?? now,
  };
};

const sameMeta = (left: DocMetaRecord | undefined, right: DocMetaRecord | undefined): boolean => {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.sourceUrl === right.sourceUrl &&
    left.createdBy === right.createdBy &&
    left.savedAt === right.savedAt &&
    left.tags.length === right.tags.length &&
    left.tags.every((tag, index) => tag === right.tags[index])
  );
};

// ---- ops ----

export interface GetDocMetaResult {
  /** `{ tags: [] }` when the doc carries no record. */
  readonly meta: DocMetaRecord;
  readonly diagnostics: readonly string[];
}

export const getDocMeta = async (
  input: PatchTargetInput,
  deps: PatchDeps,
): Promise<GetDocMetaResult> => {
  const target = await resolveTarget(input, deps.fs);
  const file = await readDocMetaFile(target, deps);
  return {
    meta: file.docs.get(target.relative) ?? EMPTY_META,
    diagnostics: file.diagnostics,
  };
};

export interface SetDocMetaInput extends PatchTargetInput {
  readonly patch: DocMetaPatch;
  /** `user` for HTTP/CLI, `agent` for MCP — recorded only when the record is first created. */
  readonly by: DocMetaCreator;
}

export interface SetDocMetaResult {
  readonly meta: DocMetaRecord;
  /** `false` when the patch reproduces the stored record exactly — no file is written then. */
  readonly changed: boolean;
  readonly diagnostics: readonly string[];
}

export const setDocMeta = async (
  input: SetDocMetaInput,
  deps: PatchDeps,
  options: PatchOptions = {},
): Promise<SetDocMetaResult> => {
  const by = creatorOf(input.by);
  const target = await resolveTarget(input, deps.fs);
  return await runLocked({ lockPath: metaLockOf(target.storeDir) }, deps, options, async () => {
    const file = await readDocMetaFile(target, deps);
    const current = file.docs.get(target.relative);
    const merged = mergedOf(current, input.patch, by, deps.clock.now().toISOString());
    if (merged === undefined || sameMeta(current, merged)) {
      return { meta: current ?? EMPTY_META, changed: false, diagnostics: file.diagnostics };
    }
    // A Map, never an object literal: `target.relative` may be `__proto__`/`constructor`,
    // and only Map.set keeps such a key as data instead of hitting the prototype chain.
    const docs = new Map(file.docs);
    docs.set(target.relative, merged);
    await writeDocMetaFile(target, deps, file, docs);
    return { meta: merged, changed: true, diagnostics: file.diagnostics };
  });
};
