// This layer pins `sanitizePdfLinks` — the fail-closed post-processor every
// `hr pdf` output passes through before validation and write (D45): Chrome's
// link annotations are authoritative only after the allowlist verdict, so the
// artifact never carries a capability URL, a local file: path, or an
// executable scheme, no matter what DOM shape produced the annotation.
//
// Documents are hand-built with pdf-lib: the point is the object shapes a real
// producer can emit — /URI as literal or hex string or indirect object, /A
// actions of every subtype, /Dest internal links, non-Link annotations — not
// Chrome's particular serialization.

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRef,
  PDFString,
} from "pdf-lib";
import { describe, expect, it } from "vitest";

import { HrError } from "@hreader/core";

import { sanitizePdfLinks } from "../src/pdf/links";

/** One /Link annotation dict; `action` is the /A dictionary body. */
const linkAnnotOf = (
  doc: PDFDocument,
  action: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): PDFDict =>
  doc.context.obj({
    Type: "Annot",
    Subtype: "Link",
    Rect: [0, 0, 120, 20],
    A: action,
    ...extra,
  });

const uriAnnotOf = (doc: PDFDocument, uri: string): PDFDict =>
  linkAnnotOf(doc, { S: "URI", URI: PDFString.of(uri) });

/** A one-page PDF; every annot is registered and referenced like a real producer emits. */
const buildPdfOf = async (annots: PDFDict[]): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 400]);
  if (annots.length > 0) {
    const array = doc.context.obj(annots.map((annot) => doc.context.register(annot)));
    page.node.set(PDFName.of("Annots"), array);
  }
  return doc.save({ updateMetadata: false });
};

interface LinkAnnots {
  readonly uris: string[];
  readonly annots: number;
}

/** Independent walk over the product bytes: surviving /URI strings and the /Annots entry count. */
const linkAnnotsOf = async (bytes: Uint8Array): Promise<LinkAnnots> => {
  const document = await PDFDocument.load(bytes);
  const uris: string[] = [];
  let annots = 0;
  for (const page of document.getPages()) {
    const array = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (array === undefined) continue;
    annots += array.size();
    for (const entry of array.asArray()) {
      const annot = entry instanceof PDFRef ? document.context.lookup(entry) : entry;
      if (!(annot instanceof PDFDict)) continue;
      if (annot.get(PDFName.of("Subtype"))?.toString() !== "/Link") continue;
      const action = annot.get(PDFName.of("A"));
      const act = action instanceof PDFRef ? document.context.lookup(action) : action;
      if (!(act instanceof PDFDict)) continue;
      const uri = act.lookup(PDFName.of("URI"));
      if (uri instanceof PDFString || uri instanceof PDFHexString) {
        uris.push(uri.decodeText());
      }
    }
  }
  return { uris, annots };
};

const EXPORT_URL = "http://hreader-export.invalid/f/cap/img.png";

// The URI allowlist contract, pinned as (input -> survives). Every same-origin
// shape the export origin can produce is covered by the host check; every
// scheme outside http/https/mailto dies regardless of how it was cased or padded.
const URI_CASES: readonly (readonly [string, boolean])[] = [
  ["https://example.com/x.png", true],
  ["http://example.com/y.png", true],
  ["HTTP://EXAMPLE.COM/up.png", true],
  ["mailto:a@b.c", true],
  ["file:///tmp/page/img.png", false],
  ["FILE:///tmp/page/img.png", false],
  ["javascript:alert(1)", false],
  ["JavaScript:alert(1)", false],
  ["data:text/plain;base64,eA==", false],
  ["blob:https://example.com/uuid", false],
  ["ftp://example.com/x", false],
  ["img.png", false],
  ["./x.png?q=1#frag", false],
  ["not a url at all", false],
  [" file:///tmp/x.png", false],
  ["\tfile:///tmp/x.png", false],
  ["file:///tmp/x.png", false],
  [EXPORT_URL, false],
  ["https://HREADER-EXPORT.INVALID/f/cap/x", false],
];

describe("sanitizePdfLinks · /URI allowlist", () => {
  it("should keep only http/https/mailto links off the export host, verbatim", async () => {
    const doc = await PDFDocument.create();
    const bytes = await buildPdfOf(URI_CASES.map(([uri]) => uriAnnotOf(doc, uri)));
    const { uris } = await linkAnnotsOf(await sanitizePdfLinks(bytes));
    expect(uris).toEqual(URI_CASES.filter(([, keep]) => keep).map(([uri]) => uri));
  });

  it("should read the /URI through a hex string and an indirect object too", async () => {
    const doc = await PDFDocument.create();
    const indirectUri = doc.context.register(PDFString.of("file:///tmp/indirect.png"));
    const hexUri = PDFHexString.fromText("file:///tmp/hex.png");
    const bytes = await buildPdfOf([
      linkAnnotOf(doc, { S: "URI", URI: hexUri }),
      linkAnnotOf(doc, { S: "URI", URI: indirectUri }),
      uriAnnotOf(doc, "https://example.com/keep"),
    ]);
    const { uris } = await linkAnnotsOf(await sanitizePdfLinks(bytes));
    expect(uris).toEqual(["https://example.com/keep"]);
  });

  it("should drop a /URI action whose value is not a string at all", async () => {
    const doc = await PDFDocument.create();
    const bytes = await buildPdfOf([
      linkAnnotOf(doc, { S: "URI", URI: PDFName.of("NotAString") }),
      uriAnnotOf(doc, "https://example.com/keep"),
    ]);
    const { uris } = await linkAnnotsOf(await sanitizePdfLinks(bytes));
    expect(uris).toEqual(["https://example.com/keep"]);
  });
});

describe("sanitizePdfLinks · action and annotation kinds", () => {
  it("should delete Launch/GoToR/JavaScript/SubmitForm actions but keep GoTo and Dest", async () => {
    const doc = await PDFDocument.create();
    const bytes = await buildPdfOf([
      linkAnnotOf(doc, { S: "Launch", F: PDFString.of("run.exe") }),
      linkAnnotOf(doc, { S: "GoToR", F: PDFString.of("other.pdf") }),
      linkAnnotOf(doc, { S: "JavaScript", JS: PDFString.of("app.alert(1)") }),
      linkAnnotOf(doc, { S: "SubmitForm", F: PDFString.of("https://x") }),
      linkAnnotOf(doc, { S: "GoTo", D: [0, 0, 0] }),
      linkAnnotOf(doc, {}, { Dest: PDFName.of("sec") }),
    ]);
    const { annots } = await linkAnnotsOf(await sanitizePdfLinks(bytes));
    expect(annots).toBe(2);
  });

  it("should leave non-Link annotations alone even when they carry a /URI action", async () => {
    const doc = await PDFDocument.create();
    const bytes = await buildPdfOf([
      doc.context.obj({
        Type: "Annot",
        Subtype: "Text",
        Rect: [0, 0, 20, 20],
        A: { S: "URI", URI: PDFString.of("file:///tmp/x.png") },
      }),
    ]);
    const { annots } = await linkAnnotsOf(await sanitizePdfLinks(bytes));
    expect(annots).toBe(1);
  });

  it("should keep a Link annotation that has no action to leak", async () => {
    const doc = await PDFDocument.create();
    const bytes = await buildPdfOf([linkAnnotOf(doc, {})]);
    const { annots } = await linkAnnotsOf(await sanitizePdfLinks(bytes));
    expect(annots).toBe(1);
  });
});

describe("sanitizePdfLinks · pass-through and failure contract", () => {
  it("should return the original bytes when nothing needs removing", async () => {
    const doc = await PDFDocument.create();
    const bytes = await buildPdfOf([
      uriAnnotOf(doc, "https://example.com/x.png"),
      uriAnnotOf(doc, "mailto:a@b.c"),
      linkAnnotOf(doc, {}, { Dest: PDFName.of("sec") }),
    ]);
    // Reference identity, not just equality: the no-strip path must not
    // re-serialize at all, so a clean managed export stays byte-identical.
    expect(await sanitizePdfLinks(bytes)).toBe(bytes);
  });

  it("should return the original bytes for a page without /Annots", async () => {
    const bytes = await buildPdfOf([]);
    expect(await sanitizePdfLinks(bytes)).toBe(bytes);
  });

  it("should fail closed with render_empty when the bytes cannot be parsed", async () => {
    const failure = await sanitizePdfLinks(Buffer.from("%PDF-1.4\n%%EOF\n")).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(HrError);
    expect((failure as HrError).code).toBe("render_empty");
  });
});
