// This layer: the shared wire shape of a merged annotation entry — used by `hr_outline`'s
// `sidecarAnnotations` and by `hr_list_annotations`. Free-text fields are cut at code points so
// a single fat record cannot flood the context (same contract as the server's relocation body).

import { cutAtCodePoint, type DocAnnotationEntry, type RelocateResult } from "@hreader/core";

/** `note`/`exact` caps: pending annotations already cap `comment` at 200 in `pendingAnnotations`; the sidecar entries keep the same width. */
const NOTE_WIRE_LIMIT = 200;
const EXACT_WIRE_LIMIT = 200;
/** `id`/`nodeId`/`selector` are unbounded at the model layer: same 200 cap so a fat record cannot flood the entry. */
const FIELD_WIRE_LIMIT = 200;

/** Same shape as `server/sidecar-replies.ts`'s `relocationBody`: `via` only rides on success; a lost anchor reports `reason` alone. */
const relocationBody = (relocation: RelocateResult): Record<string, unknown> =>
  relocation.ok
    ? { ok: true, start: relocation.start, end: relocation.end, via: relocation.via }
    : { ok: false, reason: relocation.reason };

export const annotationEntryBody = (
  entry: DocAnnotationEntry,
  file?: string,
): Record<string, unknown> => ({
  ...(file === undefined ? {} : { file }),
  id: cutAtCodePoint(entry.annotation.id, FIELD_WIRE_LIMIT),
  ...(entry.annotation.nodeId === undefined
    ? {}
    : { nodeId: cutAtCodePoint(entry.annotation.nodeId, FIELD_WIRE_LIMIT) }),
  ...(entry.annotation.selector === undefined
    ? {}
    : { selector: cutAtCodePoint(entry.annotation.selector, FIELD_WIRE_LIMIT) }),
  note: cutAtCodePoint(entry.annotation.note, NOTE_WIRE_LIMIT),
  exact: cutAtCodePoint(entry.annotation.anchor.exact, EXACT_WIRE_LIMIT),
  status: entry.annotation.status,
  source: entry.source,
  relocation: relocationBody(entry.anchor),
});
