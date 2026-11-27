// This layer: fail-closed link-annotation hygiene for every `hr pdf` artifact.
// Chrome stamps each resolved href into the product's `/URI` actions verbatim —
// the minted capability origin, the print sheet's `file://` temp dir, and
// executable schemes all ride the same channel, and no DOM-level rewrite can
// see every shape (SVG anchors, shadow roots, imagemaps). The verdict here is
// allowlist-only and never consults the DOM: a `/Link` annotation keeps its
// `/URI` action only when the scheme is http/https/mailto and the host is not
// the export origin; executable/remote action subtypes die; `/Dest` and
// `/GoTo` internal links pass. Anything the walker cannot positively classify
// as allowed is dropped, and any parse failure fails the export closed.

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  type PDFObject,
  PDFRef,
  PDFString,
} from "pdf-lib";

import { HrError } from "@hreader/core";

import { firstErrorLineOf, messageOf } from "../errors";

const ANNOTS = PDFName.of("Annots");
const SUBTYPE = PDFName.of("Subtype");
const ACTION = PDFName.of("A");
const KIND = PDFName.of("S");
const URI = PDFName.of("URI");

/** The minted origin every export serves from — `.invalid` is RFC-2606 reserved, and an export URL is dead everywhere else anyway. */
const EXPORT_HOST = "hreader-export.invalid";

const KEEP_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** `/A` action subtypes that can reach outside the document — every one dies regardless of what it points at. `asString()` keeps the `/` prefix, so names compare slash-first. */
const DROP_ACTIONS = new Set(["/Launch", "/GoToR", "/JavaScript", "/SubmitForm"]);

/** Follow one level of indirection: producers emit dicts both inline and by reference. */
const dictOf = (document: PDFDocument, value: PDFObject | undefined): PDFDict | undefined => {
  const resolved = value instanceof PDFRef ? document.context.lookup(value) : value;
  return resolved instanceof PDFDict ? resolved : undefined;
};

const nameOf = (document: PDFDocument, entries: PDFDict, key: PDFName): string | undefined => {
  const value = entries.get(key);
  const resolved = value instanceof PDFRef ? document.context.lookup(value) : value;
  return resolved instanceof PDFName ? resolved.asString() : undefined;
};

/** `/URI` values arrive as literal strings, hex strings, or indirectly — anything else is not a URI we can vouch for. */
const uriTextOf = (document: PDFDocument, action: PDFDict): string | undefined => {
  const value = action.get(URI);
  const resolved = value instanceof PDFRef ? document.context.lookup(value) : value;
  if (resolved instanceof PDFString || resolved instanceof PDFHexString) {
    return resolved.decodeText();
  }
  return undefined;
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

/** One `/Link` annotation's verdict: its `/A` action decides — a missing or untyped action carries nothing that can leak. */
const keepsLinkOf = (document: PDFDocument, annot: PDFDict): boolean => {
  const action = dictOf(document, annot.get(ACTION));
  if (action === undefined) return true;
  const kind = nameOf(document, action, KIND);
  if (kind === "/URI") {
    const text = uriTextOf(document, action);
    return text !== undefined && keepsUriOf(text);
  }
  if (kind === undefined) return true;
  return !DROP_ACTIONS.has(kind);
};

/**
 * Drops leaking `/Link` annotations in place and returns the artifact bytes.
 * With nothing to remove the input buffer comes back untouched — not
 * re-serialized — so a clean managed export stays byte-identical. Any parse
 * or walk failure throws `render_empty`: the command must never write bytes
 * the sanitizer could not vouch for.
 */
export const sanitizePdfLinks = async (bytes: Uint8Array): Promise<Uint8Array> => {
  try {
    const document = await PDFDocument.load(bytes, { throwOnInvalidObject: true });
    let removed = 0;
    for (const page of document.getPages()) {
      const annots = page.node.lookupMaybe(ANNOTS, PDFArray);
      if (annots === undefined) continue;
      const kept: PDFObject[] = [];
      for (const entry of annots.asArray()) {
        const annot = dictOf(document, entry);
        const isLink = annot !== undefined && nameOf(document, annot, SUBTYPE) === "/Link";
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
