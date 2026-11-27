// This layer: fail-closed link-annotation hygiene for every `hr pdf` artifact.
// Chrome stamps each resolved href into the product's `/URI` actions verbatim —
// the minted capability origin, the print sheet's `file://` temp dir, and
// executable schemes all ride the same channel, and no DOM-level rewrite can
// see every shape (SVG anchors, shadow roots, imagemaps). The verdict here is a
// strict allowlist over the artifact alone, applied to `/Subtype /Link` dicts:
// a Link survives only as exactly (a) `/Dest` with no `/A`, or (b) a single
// `/A` action dictionary whose `/S` is exactly `/URI` with an allowlisted
// target or exactly `/GoTo`. A Link with `/AA`, an action carrying `/Next`, an
// annotation-level `/URI`, or any other shape dies; non-Link annotations are
// untouched; and any unresolvable object inside an annotation — not just the
// keys the verdict consults — fails the whole export closed.

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  type PDFObject,
  type PDFPage,
  PDFRef,
  PDFString,
} from "pdf-lib";

import { HrError } from "@hreader/core";

import { firstErrorLineOf, messageOf } from "../errors";

const ANNOTS = PDFName.of("Annots");
const SUBTYPE = PDFName.of("Subtype");
const ACTION = PDFName.of("A");
const ADDITIONAL_ACTIONS = PDFName.of("AA");
const NEXT = PDFName.of("Next");
const DEST = PDFName.of("Dest");
const KIND = PDFName.of("S");
const URI = PDFName.of("URI");

/** The minted origin every export serves from — `.invalid` is RFC-2606 reserved, and an export URL is dead everywhere else anyway. */
const EXPORT_HOST = "hreader-export.invalid";

const KEEP_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** Deepest level of an annotation's object graph the resolvability walk descends — a kept annotation can only reach out through the keys the verdict already consults, so the bound is armor against unbounded graphs, not logic. */
const RESOLVABLE_DEPTH = 4;

/** Follow one level of indirection: producers emit values both inline and by reference. A dangling reference resolves to undefined — callers decide whether that is a drop verdict or a hard failure. */
const resolveOf = (document: PDFDocument, value: PDFObject | undefined): PDFObject | undefined =>
  value instanceof PDFRef ? document.context.lookup(value) : value;

/**
 * Every reference reachable from the annotation's dict must resolve. The walk
 * descends into nested dicts and arrays (depth-bounded, cycle-guarded), so an
 * attacker cannot hide an unvetted object behind /AA, /Next, an appearance
 * entry, or any key the keep-verdict never reads — anything unresolvable is a
 * hard failure, not a quiet keep.
 */
const assertResolvableOf = (document: PDFDocument, dict: PDFDict): void => {
  const seen = new Set<PDFObject>();
  const visit = (value: PDFObject, depth: number): void => {
    if (value instanceof PDFRef) {
      const resolved = document.context.lookup(value);
      if (resolved === undefined) {
        throw new Error(`unresolvable object ${value.toString()} inside an annotation`);
      }
      visit(resolved, depth);
      return;
    }
    if (depth <= 0 || seen.has(value)) return;
    if (value instanceof PDFDict) {
      seen.add(value);
      for (const [, entry] of value.entries()) visit(entry, depth - 1);
      return;
    }
    if (value instanceof PDFArray) {
      seen.add(value);
      for (const entry of value.asArray()) visit(entry, depth - 1);
    }
  };
  for (const [, entry] of dict.entries()) visit(entry, RESOLVABLE_DEPTH);
};

/** A page's `/Annots`: absent means skip, but present-but-wrong or dangling fails the export — an unreadable array is an unvetted one. */
const annotsArrayOf = (document: PDFDocument, page: PDFPage): PDFArray | undefined => {
  const value = page.node.get(ANNOTS);
  if (value === undefined) return undefined;
  const resolved = resolveOf(document, value);
  if (resolved === undefined) throw new Error("page /Annots is unresolvable");
  if (!(resolved instanceof PDFArray)) throw new Error("page /Annots is not an array");
  return resolved;
};

/** One `/Annots` entry: only a resolvable dictionary may proceed to a verdict — a scalar, an invalid object, or a dangling reference fails closed. */
const annotDictOf = (document: PDFDocument, entry: PDFObject): PDFDict => {
  const resolved = resolveOf(document, entry);
  if (resolved === undefined) throw new Error("unresolvable annotation entry");
  if (!(resolved instanceof PDFDict)) throw new Error("annotation entry is not a dictionary");
  return resolved;
};

const dictOf = (document: PDFDocument, value: PDFObject | undefined): PDFDict | undefined => {
  const resolved = resolveOf(document, value);
  return resolved instanceof PDFDict ? resolved : undefined;
};

const nameOf = (document: PDFDocument, entries: PDFDict, key: PDFName): string | undefined => {
  const resolved = resolveOf(document, entries.get(key));
  return resolved instanceof PDFName ? resolved.asString() : undefined;
};

/** `/URI` values arrive as literal strings, hex strings, or indirectly — anything else is not a URI we can vouch for. */
const uriTextOf = (document: PDFDocument, action: PDFDict): string | undefined => {
  const resolved = resolveOf(document, action.get(URI));
  return resolved instanceof PDFString || resolved instanceof PDFHexString
    ? resolved.decodeText()
    : undefined;
};

/**
 * WHATWG URL parsing is the oracle: it trims leading control characters and
 * lowercases scheme and host, so ` FILE:`, `JavaScript:` and
 * `HREADER-EXPORT.INVALID` cannot slip past on casing or padding — and a
 * malformed or schemeless string throws, which is a drop verdict.
 */
const keepsUriOf = (text: string): boolean => {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (!KEEP_SCHEMES.has(url.protocol)) return false;
  return url.hostname.toLowerCase() !== EXPORT_HOST;
};

/**
 * One `/Link` annotation's verdict — the strict allowlist. The annotation dies
 * outright when it carries `/AA` (any trigger is executable) or its own `/URI`
 * key (an unmediated action target). Otherwise exactly two shapes keep: `/Dest`
 * with no `/A`, or `/A` as one action dictionary — never an array, never a
 * non-dictionary — with no `/Next` chain, whose `/S` is exactly `/URI` naming
 * an allowlisted target, or exactly `/GoTo`. Name comparisons stay
 * slash-prefixed and case-sensitive: `/uri` is not `/URI`.
 */
const keepsLinkOf = (document: PDFDocument, annot: PDFDict): boolean => {
  if (annot.get(ADDITIONAL_ACTIONS) !== undefined) return false;
  if (annot.get(URI) !== undefined) return false;
  const actionValue = annot.get(ACTION);
  if (actionValue === undefined) return annot.get(DEST) !== undefined;
  const action = dictOf(document, actionValue);
  if (action === undefined) return false;
  if (action.get(NEXT) !== undefined) return false;
  const kind = nameOf(document, action, KIND);
  if (kind === "/URI") {
    const text = uriTextOf(document, action);
    return text !== undefined && keepsUriOf(text);
  }
  return kind === "/GoTo";
};

/**
 * Drops unvetted `/Link` annotations in place and returns the artifact bytes.
 * With nothing to remove the input buffer comes back untouched — not
 * re-serialized — so a clean managed export stays byte-identical. Any parse,
 * resolution, or shape failure throws `render_empty`: the command must never
 * write bytes the sanitizer could not vouch for.
 */
export const sanitizePdfLinks = async (bytes: Uint8Array): Promise<Uint8Array> => {
  try {
    const document = await PDFDocument.load(bytes, { throwOnInvalidObject: true });
    let removed = 0;
    for (const page of document.getPages()) {
      const annots = annotsArrayOf(document, page);
      if (annots === undefined) continue;
      const kept: PDFObject[] = [];
      for (const entry of annots.asArray()) {
        const annot = annotDictOf(document, entry);
        assertResolvableOf(document, annot);
        const isLink = nameOf(document, annot, SUBTYPE) === "/Link";
        if (isLink && !keepsLinkOf(document, annot)) {
          removed += 1;
          continue;
        }
        kept.push(entry);
      }
      if (kept.length !== annots.size()) {
        page.node.set(ANNOTS, document.context.obj(kept));
      }
    }
    if (removed === 0) return bytes;
    return await document.save();
  } catch (error: unknown) {
    throw new HrError("render_empty", `PDF 结构解析不出：${firstErrorLineOf(messageOf(error))}`, {
      cause: error,
    });
  }
};
