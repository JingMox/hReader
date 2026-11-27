// This layer: pure data types and the page-size table shared by the render layer; zero I/O, zero third-party deps.

import type { Reply } from "@hreader/core";

export type PdfPageSize = "a4" | "letter" | "a5";

interface PaperSize {
  readonly widthPt: number;
  readonly heightPt: number;
}

/** Page-size table (pt); Chrome's print output rounds to +/-1.5pt, and e2e compares with that tolerance. */
export const PAGE_SIZES: Readonly<Record<PdfPageSize, PaperSize>> = {
  a4: { widthPt: 595.28, heightPt: 841.89 },
  letter: { widthPt: 612.0, heightPt: 792.0 },
  a5: { widthPt: 419.53, heightPt: 595.28 },
};

export const isPdfPageSize = (value: string): value is PdfPageSize =>
  value === "a4" || value === "letter" || value === "a5";

/** Tall-image request: `width`/`maxHeight` are CSS pixels, `scale` the device-pixel factor (overflow past `maxHeight` is clipped, not scaled). */
export interface PngViewport {
  readonly width: number;
  readonly scale: number;
  readonly maxHeight: number;
}

export interface LongImage {
  readonly bytes: Uint8Array;
  /** The width/height below are read back from IHDR (device pixels). */
  readonly width: number;
  readonly height: number;
  readonly clipped: boolean;
}

/**
 * Per-request verdict from the export gate: `serve` answers from the local
 * /f/ serving layer (no socket touched), `allow` releases the request to the
 * network (only ever for a granted page), `deny` fails it closed.
 */
export type ExportGateAnswer =
  | { readonly kind: "serve"; readonly reply: Reply }
  | { readonly kind: "allow" }
  | { readonly kind: "deny" };

/** One gated request, post-verdict: the audit trail a test asserts the permission model against. */
export interface ExportRequestRecord {
  readonly url: string;
  readonly action: "serve" | "allow" | "deny";
  /** HTTP status a `serve` verdict carried; absent for allow/deny. */
  readonly status?: number;
}

/**
 * The same-origin link hygiene a PDF export performs before printToPDF:
 * anchors that resolved onto the minted capability origin are rewritten in
 * the page so no dead `hreader-export.invalid` URL survives into the
 * artifact's link annotations. A fragment link to the document itself stays
 * internal; a link under the cap scope becomes the `file:` URL of the real
 * asset; any other same-origin link loses its href (no annotation).
 * External links are untouched.
 */
export interface ExportLinkRewrite {
  /** The minted origin Chrome resolved the frame's links against. */
  readonly origin: string;
  /** The frame's own `/f/<cap>/<doc>` path — a same-path anchor with a fragment stays an internal link. */
  readonly framePath: string;
  /** `/f/<cap>/` — same-origin paths under it map onto the document's real directory. */
  readonly capPrefix: string;
  /** `file:` URL of the document's real directory with a trailing slash — the base siblings rewrite onto. */
  readonly fileBase: string;
}

/**
 * The plan a foreign document exports under: the capability URL Chrome
 * navigates to plus the per-request verdict it runs. The same shape the
 * reader's `/f/` route enforces, minus the socket.
 */
export interface ForeignPagePlan {
  readonly url: string;
  /** The document's file name — the /Title fallback when it carries no `<title>` (the URL would leak the minted origin instead). */
  readonly docName: string;
  /** The link-annotation hygiene the PDF path applies before printToPDF — PNG pixels carry no URLs, so it does not run there. */
  readonly linkRewrite: ExportLinkRewrite;
  readonly gate: (url: string, method: string) => Promise<ExportGateAnswer>;
}

/** What the render layer opens: a managed print sheet via `file://`, or a foreign doc behind its capability URL. */
export type RenderSource =
  | { readonly kind: "sheet"; readonly html: string }
  | { readonly kind: "foreign"; readonly page: ForeignPagePlan };
