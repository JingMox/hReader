// This layer pins `sanitizePdfLinks` — the fail-closed post-processor every
// `hr pdf` output passes through before validation and write (D45/D48): a
// `/Link` annotation is kept only if it is exactly `/Dest` with no `/A`, or a
// single `/A` action dict whose `/S` is exactly `/URI` (allowlisted target) or
// exactly `/GoTo`. `/AA`, `/Next`, annot-level `/URI`, and every unrecognized
// shape drop the annotation; anything unresolvable inside it fails the export.
//
// Documents are hand-built with pdf-lib: the point is the object shapes a real
// producer can emit — /URI as literal or hex string or indirect object, /A as
// dict or array or non-dict, /Next chains, /AA triggers, non-Link annotations —
// not Chrome's particular serialization.

import fc from "fast-check";
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
import { describe, expect, it } from "vitest";

import { HrError } from "@hreader/core";

import { sanitizePdfLinks } from "../src/pdf/links";

/** The value shapes `context.obj` accepts: scalars, arrays, nested dicts, and real PDFObjects (names, strings, refs). */
type LitValue =
  string | number | boolean | PDFObject | readonly LitValue[] | { [key: string]: LitValue };

const ANNOTS = PDFName.of("Annots");
const SUBTYPE = PDFName.of("Subtype");
const ACTION = PDFName.of("A");
const AA = PDFName.of("AA");
const NEXT = PDFName.of("Next");
const DEST = PDFName.of("Dest");
const KIND = PDFName.of("S");
const URI = PDFName.of("URI");

/** One /Link annotation dict; `action` is the /A value verbatim (dict body, array, or object). Name-typed values ride `PDFName.of` — `context.obj` turns a bare string into a PDFString, which is not what producers emit. */
const linkAnnotOf = (
  doc: PDFDocument,
  action: LitValue,
  extra: Record<string, LitValue> = {},
): PDFDict =>
  doc.context.obj({
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("Link"),
    Rect: [0, 0, 120, 20],
    A: action,
    ...extra,
  });

/** Shape (a): a /Link with /Dest and NO /A key — a bare `A: action` would move it out of shape (a). */
const destAnnotOf = (doc: PDFDocument, dest: LitValue): PDFDict =>
  doc.context.obj({
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("Link"),
    Rect: [0, 0, 120, 20],
    Dest: dest,
  });

const uriAnnotOf = (doc: PDFDocument, uri: string): PDFDict =>
  linkAnnotOf(doc, { S: PDFName.of("URI"), URI: PDFString.of(uri) });

/** A one-page PDF; every annot is registered and referenced like a real producer emits. `make` gets the real document — a ref minted on any other context would dangle into whatever object number it happened to reuse. Entries that are not dicts land in /Annots verbatim, to pin the structural verdicts. */
const buildPdfOf = async (make: (doc: PDFDocument) => PDFObject[]): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 400]);
  const annots = make(doc);
  if (annots.length > 0) {
    const array = doc.context.obj(
      annots.map((annot) => (annot instanceof PDFDict ? doc.context.register(annot) : annot)),
    );
    page.node.set(ANNOTS, array);
  }
  return doc.save();
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
    const array = page.node.lookupMaybe(ANNOTS, PDFArray);
    if (array === undefined) continue;
    annots += array.size();
    for (const entry of array.asArray()) {
      const annot = entry instanceof PDFRef ? document.context.lookup(entry) : entry;
      if (!(annot instanceof PDFDict)) continue;
      if (annot.get(SUBTYPE)?.toString() !== "/Link") continue;
      const action = annot.get(ACTION);
      const act = action instanceof PDFRef ? document.context.lookup(action) : action;
      if (!(act instanceof PDFDict)) continue;
      const uri = act.lookup(URI);
      if (uri instanceof PDFString || uri instanceof PDFHexString) {
        uris.push(uri.decodeText());
      }
    }
  }
  return { uris, annots };
};

/** The resolved dict of every surviving /Link annotation plus the document that owns them — the property test's oracle surface. */
const survivingLinkDictsOf = async (
  bytes: Uint8Array,
): Promise<{ document: PDFDocument; links: PDFDict[] }> => {
  const document = await PDFDocument.load(bytes);
  const links: PDFDict[] = [];
  for (const page of document.getPages()) {
    const array = page.node.lookupMaybe(ANNOTS, PDFArray);
    if (array === undefined) continue;
    for (const entry of array.asArray()) {
      const annot = entry instanceof PDFRef ? document.context.lookup(entry) : entry;
      if (!(annot instanceof PDFDict)) continue;
      if (annot.get(SUBTYPE)?.toString() === "/Link") links.push(annot);
    }
  }
  return { document, links };
};

/** The total /Annots entry count across pages, Links and non-Links alike. */
const annotCountOf = async (bytes: Uint8Array): Promise<number> => {
  const document = await PDFDocument.load(bytes);
  let annots = 0;
  for (const page of document.getPages()) {
    const array = page.node.lookupMaybe(ANNOTS, PDFArray);
    if (array !== undefined) annots += array.size();
  }
  return annots;
};

const failureOf = (bytes: Uint8Array): Promise<unknown> =>
  sanitizePdfLinks(bytes).catch((error: unknown) => error);

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
  ["file:///tmp/x.png", false],
  [EXPORT_URL, false],
  ["https://HREADER-EXPORT.INVALID/f/cap/x", false],
];

describe("sanitizePdfLinks · /URI allowlist", () => {
  it("should keep only http/https/mailto links off the export host, verbatim", async () => {
    const bytes = await buildPdfOf((doc) => URI_CASES.map(([uri]) => uriAnnotOf(doc, uri)));
    const { uris } = await linkAnnotsOf(await sanitizePdfLinks(bytes));
    expect(uris).toEqual(URI_CASES.filter(([, keep]) => keep).map(([uri]) => uri));
  });

  it("should read the /URI through a hex string and an indirect object too", async () => {
    const bytes = await buildPdfOf((doc) => [
      linkAnnotOf(doc, { S: PDFName.of("URI"), URI: PDFHexString.fromText("file:///tmp/hex.png") }),
      linkAnnotOf(doc, {
        S: PDFName.of("URI"),
        URI: doc.context.register(PDFString.of("file:///tmp/indirect.png")),
      }),
      uriAnnotOf(doc, "https://example.com/keep"),
    ]);
    const { uris } = await linkAnnotsOf(await sanitizePdfLinks(bytes));
    expect(uris).toEqual(["https://example.com/keep"]);
  });

  it("should drop a /URI action whose value is not a string at all", async () => {
    const bytes = await buildPdfOf((doc) => [
      linkAnnotOf(doc, { S: PDFName.of("URI"), URI: PDFName.of("NotAString") }),
      linkAnnotOf(doc, { S: PDFName.of("URI"), URI: { Host: PDFString.of("example.com") } }),
      linkAnnotOf(doc, { S: PDFName.of("URI"), URI: [PDFString.of("https://example.com")] }),
      linkAnnotOf(doc, { S: PDFName.of("URI"), URI: 42 }),
      uriAnnotOf(doc, "https://example.com/keep"),
    ]);
    const { uris } = await linkAnnotsOf(await sanitizePdfLinks(bytes));
    expect(uris).toEqual(["https://example.com/keep"]);
  });

  it("should resolve the /S action kind through an indirect object", async () => {
    const bytes = await buildPdfOf((doc) => [
      linkAnnotOf(doc, {
        S: doc.context.register(PDFName.of("URI")),
        URI: PDFString.of("file:///tmp/x.png"),
      }),
      uriAnnotOf(doc, "https://example.com/keep"),
    ]);
    const { uris } = await linkAnnotsOf(await sanitizePdfLinks(bytes));
    expect(uris).toEqual(["https://example.com/keep"]);
  });

  it("should keep a Link whose /URI action dictionary arrives indirectly", async () => {
    const bytes = await buildPdfOf((doc) => [
      linkAnnotOf(
        doc,
        doc.context.register(
          doc.context.obj({ S: PDFName.of("URI"), URI: PDFString.of("https://example.com/ok") }),
        ),
      ),
    ]);
    const { uris } = await linkAnnotsOf(await sanitizePdfLinks(bytes));
    expect(uris).toEqual(["https://example.com/ok"]);
  });
});

describe("sanitizePdfLinks · the strict keep shapes", () => {
  // The whole non-allowlisted /S vocabulary: every action kind a Link could
  // carry besides /URI and /GoTo dies — allowlist, not blocklist.
  const DROPPED_KINDS = [
    "Launch",
    "GoToR",
    "JavaScript",
    "SubmitForm",
    "ImportData",
    "RichMediaExecute",
    "Rendition",
    "Sound",
    "Movie",
    "SetOCGState",
    "Named",
    "Hide",
    "Thread",
    "Trans",
    "GoTo3DView",
    "ResetForm",
    // A lowercase /uri is not the /URI name — case-sensitive by spec.
    "uri",
  ] as const;

  it("should drop every action kind outside /URI and /GoTo", async () => {
    const bytes = await buildPdfOf((doc) =>
      DROPPED_KINDS.map((kind) =>
        linkAnnotOf(doc, { S: PDFName.of(kind), URI: PDFString.of("https://example.com/x") }),
      ),
    );
    const { annots } = await linkAnnotsOf(await sanitizePdfLinks(bytes));
    expect(annots).toBe(0);
  });

  it("should keep exactly the two sanctioned shapes", async () => {
    const bytes = await buildPdfOf((doc) => [
      linkAnnotOf(doc, { S: PDFName.of("URI"), URI: PDFString.of("https://example.com/x") }),
      linkAnnotOf(doc, { S: PDFName.of("GoTo"), D: [0, 0, 0] }),
      linkAnnotOf(doc, { S: PDFName.of("GoTo") }),
      destAnnotOf(doc, PDFName.of("sec")),
      destAnnotOf(
        doc,
        doc.context.register(doc.context.obj([PDFName.of("page0"), PDFName.of("Fit")])),
      ),
    ]);
    const { annots } = await linkAnnotsOf(await sanitizePdfLinks(bytes));
    expect(annots).toBe(5);
  });

  it("should drop a Link with /Dest AND an unvetted /A — only one exact shape keeps", async () => {
    const bytes = await buildPdfOf((doc) => [
      doc.context.obj({
        Type: PDFName.of("Annot"),
        Subtype: PDFName.of("Link"),
        Rect: [0, 0, 120, 20],
        Dest: PDFName.of("sec"),
        A: { S: PDFName.of("Named"), N: PDFName.of("Print") },
      }),
    ]);
    const { annots } = await linkAnnotsOf(await sanitizePdfLinks(bytes));
    expect(annots).toBe(0);
  });

  it("should keep a Link whose /A and /Dest are both present when /A is sanctioned", async () => {
    const bytes = await buildPdfOf((doc) => [
      doc.context.obj({
        Type: PDFName.of("Annot"),
        Subtype: PDFName.of("Link"),
        Rect: [0, 0, 120, 20],
        Dest: PDFName.of("sec"),
        A: { S: PDFName.of("GoTo"), D: [0, 0, 0] },
      }),
    ]);
    const { annots } = await linkAnnotsOf(await sanitizePdfLinks(bytes));
    expect(annots).toBe(1);
  });

  it("should drop a Link with an empty /A dict and no /Dest", async () => {
    const bytes = await buildPdfOf((doc) => [linkAnnotOf(doc, {})]);
    const { annots } = await linkAnnotsOf(await sanitizePdfLinks(bytes));
    expect(annots).toBe(0);
  });

  it("should drop a Link with neither /A nor /Dest", async () => {
    const bytes = await buildPdfOf((doc) => [
      doc.context.obj({
        Type: PDFName.of("Annot"),
        Subtype: PDFName.of("Link"),
        Rect: [0, 0, 120, 20],
      }),
    ]);
    const { annots } = await linkAnnotsOf(await sanitizePdfLinks(bytes));
    expect(annots).toBe(0);
  });
});

describe("sanitizePdfLinks · chained and trigger actions", () => {
  it("should drop a kept-looking /URI action carrying /Next as a dict", async () => {
    const bytes = await buildPdfOf((doc) => [
      linkAnnotOf(doc, {
        S: PDFName.of("URI"),
        URI: PDFString.of("https://example.com/good"),
        Next: { S: PDFName.of("JavaScript"), JS: PDFString.of("app.alert(1)") },
      }),
      linkAnnotOf(doc, {
        S: PDFName.of("URI"),
        URI: PDFString.of("https://example.com/good2"),
        Next: { S: PDFName.of("Launch"), F: PDFString.of("run.exe") },
      }),
      linkAnnotOf(doc, {
        S: PDFName.of("URI"),
        URI: PDFString.of("https://example.com/good3"),
        Next: { S: PDFName.of("URI"), URI: PDFString.of("javascript:alert(1)") },
      }),
    ]);
    const { annots } = await linkAnnotsOf(await sanitizePdfLinks(bytes));
    expect(annots).toBe(0);
  });

  it("should drop a kept-looking /URI action carrying /Next as an array", async () => {
    const bytes = await buildPdfOf((doc) => [
      linkAnnotOf(doc, {
        S: PDFName.of("URI"),
        URI: PDFString.of("https://example.com/good"),
        Next: [
          { S: PDFName.of("JavaScript"), JS: PDFString.of("app.alert(1)") },
          { S: PDFName.of("Launch"), F: PDFString.of("run.exe") },
          { S: PDFName.of("URI"), URI: PDFString.of("file:///tmp/x") },
        ],
      }),
      linkAnnotOf(doc, {
        S: PDFName.of("GoTo"),
        D: [0, 0, 0],
        Next: [{ S: PDFName.of("JavaScript"), JS: PDFString.of("x()") }],
      }),
    ]);
    const { annots } = await linkAnnotsOf(await sanitizePdfLinks(bytes));
    expect(annots).toBe(0);
  });

  it("should drop a Link carrying /AA additional actions under any trigger key", async () => {
    const triggers = ["E", "X", "D", "U", "Fo", "Bl"];
    const bytes = await buildPdfOf((doc) =>
      triggers.map((trigger) =>
        linkAnnotOf(
          doc,
          { S: PDFName.of("URI"), URI: PDFString.of("https://example.com/good") },
          { AA: { [trigger]: { S: PDFName.of("JavaScript"), JS: PDFString.of("x()") } } },
        ),
      ),
    );
    const { annots } = await linkAnnotsOf(await sanitizePdfLinks(bytes));
    expect(annots).toBe(0);
  });

  it("should drop a Link whose /AA arrives indirectly", async () => {
    const bytes = await buildPdfOf((doc) => [
      linkAnnotOf(
        doc,
        { S: PDFName.of("GoTo"), D: [0, 0, 0] },
        {
          AA: doc.context.register(
            doc.context.obj({ E: { S: PDFName.of("Launch"), F: PDFString.of("run.exe") } }),
          ),
        },
      ),
    ]);
    const { annots } = await linkAnnotsOf(await sanitizePdfLinks(bytes));
    expect(annots).toBe(0);
  });

  it("should drop a Link carrying an annotation-level /URI key", async () => {
    const bytes = await buildPdfOf((doc) => [
      linkAnnotOf(
        doc,
        { S: PDFName.of("GoTo"), D: [0, 0, 0] },
        { URI: PDFString.of("javascript:alert(1)") },
      ),
      linkAnnotOf(
        doc,
        { S: PDFName.of("URI"), URI: PDFString.of("https://example.com/ok") },
        { URI: PDFString.of("file:///tmp/escape") },
      ),
    ]);
    const { annots } = await linkAnnotsOf(await sanitizePdfLinks(bytes));
    expect(annots).toBe(0);
  });
});

describe("sanitizePdfLinks · malformed action containers", () => {
  it("should drop a Link whose /A is an array of action dicts", async () => {
    const bytes = await buildPdfOf((doc) => [
      linkAnnotOf(doc, [{ S: PDFName.of("URI"), URI: PDFString.of("https://example.com/x") }]),
    ]);
    const { annots } = await linkAnnotsOf(await sanitizePdfLinks(bytes));
    expect(annots).toBe(0);
  });

  it("should drop a Link whose /A resolves to a non-dictionary", async () => {
    const bytes = await buildPdfOf((doc) => [
      linkAnnotOf(doc, doc.context.register(PDFString.of("not a dict"))),
      linkAnnotOf(doc, doc.context.register(PDFName.of("NotADict"))),
      linkAnnotOf(doc, doc.context.register(doc.context.obj([1, 2, 3]))),
    ]);
    const { annots } = await linkAnnotsOf(await sanitizePdfLinks(bytes));
    expect(annots).toBe(0);
  });

  it("should drop a Link whose /A is an inline non-dictionary", async () => {
    const bytes = await buildPdfOf((doc) => [
      linkAnnotOf(doc, PDFString.of("not a dict")),
      linkAnnotOf(doc, PDFName.of("NotADict")),
    ]);
    const { annots } = await linkAnnotsOf(await sanitizePdfLinks(bytes));
    expect(annots).toBe(0);
  });
});

describe("sanitizePdfLinks · untouched non-Link annotations", () => {
  it("should leave non-Link annotations alone even when they carry a /URI action", async () => {
    const bytes = await buildPdfOf((doc) => [
      doc.context.obj({
        Type: PDFName.of("Annot"),
        Subtype: PDFName.of("Text"),
        Rect: [0, 0, 20, 20],
        A: { S: PDFName.of("URI"), URI: PDFString.of("file:///tmp/x.png") },
      }),
    ]);
    const { annots } = await linkAnnotsOf(await sanitizePdfLinks(bytes));
    expect(annots).toBe(1);
  });

  it("should leave a lowercase-/link subtype annot untouched — it is not a /Link", async () => {
    const bytes = await buildPdfOf((doc) => [
      doc.context.obj({
        Type: PDFName.of("Annot"),
        Subtype: PDFName.of("link"),
        Rect: [0, 0, 20, 20],
        A: { S: PDFName.of("JavaScript"), JS: PDFString.of("x()") },
      }),
    ]);
    const { annots } = await linkAnnotsOf(await sanitizePdfLinks(bytes));
    expect(annots).toBe(1);
  });
});

describe("sanitizePdfLinks · structural strictness", () => {
  it("should fail closed on a non-dictionary entry inside /Annots", async () => {
    const bytes = await buildPdfOf((doc) => [
      uriAnnotOf(doc, "https://example.com/ok"),
      PDFString.of("not an annotation"),
      doc.context.obj([1, 2, 3]),
    ]);
    const failure = await failureOf(bytes);
    expect(failure).toBeInstanceOf(HrError);
    expect((failure as HrError).code).toBe("render_empty");
  });

  it("should fail closed on a dangling /Annots entry reference", async () => {
    const bytes = await buildPdfOf((doc) => [
      uriAnnotOf(doc, "https://example.com/ok"),
      PDFRef.of(9999, 0),
    ]);
    const failure = await failureOf(bytes);
    expect(failure).toBeInstanceOf(HrError);
    expect((failure as HrError).code).toBe("render_empty");
  });

  it("should fail closed when /Annots itself is not an array", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 400]);
    page.node.set(ANNOTS, PDFName.of("NotAnArray"));
    const failure = await failureOf(await doc.save());
    expect(failure).toBeInstanceOf(HrError);
    expect((failure as HrError).code).toBe("render_empty");
  });

  it("should fail closed when /Annots is a dangling reference", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 400]);
    page.node.set(ANNOTS, PDFRef.of(9998, 0));
    const failure = await failureOf(await doc.save());
    expect(failure).toBeInstanceOf(HrError);
    expect((failure as HrError).code).toBe("render_empty");
  });

  it("should fail closed on a dangling reference inside an annotation dict", async () => {
    const bytes = await buildPdfOf((doc) => [
      linkAnnotOf(doc, { S: PDFName.of("GoTo"), D: [0, 0, 0] }, { Border: PDFRef.of(9997, 0) }),
    ]);
    const failure = await failureOf(bytes);
    expect(failure).toBeInstanceOf(HrError);
    expect((failure as HrError).code).toBe("render_empty");
  });

  it("should fail closed on a dangling reference nested inside the action dict", async () => {
    const bytes = await buildPdfOf((doc) => [
      linkAnnotOf(doc, { S: PDFName.of("GoTo"), D: PDFRef.of(9996, 0) }),
    ]);
    const failure = await failureOf(bytes);
    expect(failure).toBeInstanceOf(HrError);
    expect((failure as HrError).code).toBe("render_empty");
  });

  it("should fail closed on a dangling reference behind an indirect container", async () => {
    const bytes = await buildPdfOf((doc) => [
      // The /A action dict itself arrives by reference; the dangling ref sits
      // inside the resolved object, not inside the annotation dict literal.
      linkAnnotOf(
        doc,
        doc.context.register(doc.context.obj({ S: PDFName.of("GoTo"), D: PDFRef.of(9993, 0) })),
      ),
      destAnnotOf(
        doc,
        doc.context.register(doc.context.obj([PDFName.of("pg"), PDFRef.of(9992, 0)])),
      ),
    ]);
    const failure = await failureOf(bytes);
    expect(failure).toBeInstanceOf(HrError);
    expect((failure as HrError).code).toBe("render_empty");
  });

  it("should fail closed on a dangling reference nested inside an array value", async () => {
    const bytes = await buildPdfOf((doc) => [
      destAnnotOf(doc, [PDFName.of("Fit"), PDFRef.of(9995, 0)]),
      linkAnnotOf(
        doc,
        { S: PDFName.of("GoTo"), D: [0, 0, 0] },
        { Border: [0, 0, PDFRef.of(9994, 0)] },
      ),
    ]);
    const failure = await failureOf(bytes);
    expect(failure).toBeInstanceOf(HrError);
    expect((failure as HrError).code).toBe("render_empty");
  });

  it("should fail closed on a single malformed annotation object", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 400]);
    const annot = doc.context.obj({
      Type: PDFName.of("Annot"),
      Subtype: PDFName.of("Link"),
      Rect: [0, 0, 120, 20],
      A: { S: PDFName.of("URI"), URI: PDFString.of("file:///tmp/escape.png") },
    });
    page.node.set(ANNOTS, doc.context.obj([doc.context.register(annot)]));
    const saved = await doc.save({ useObjectStreams: false });
    // Same-length corruption keeps the xref offsets intact: `?` is not a name
    // token, so the annot dict fails to parse. throwOnInvalidObject must make
    // that a hard failure — a lenient load would wrap the bytes as an
    // "invalid object" the walk cannot vet.
    const text = Buffer.from(saved).toString("latin1");
    expect(text).toContain("/Subtype /Link");
    const corrupted = new Uint8Array(
      Buffer.from(text.replace("/Subtype /Link", "?Subtype /Link"), "latin1"),
    );
    const failure = await failureOf(corrupted);
    expect(failure).toBeInstanceOf(HrError);
    expect((failure as HrError).code).toBe("render_empty");
  });
});

// The property oracle, mirrored from the D48 spec: a surviving /Link is either
// `/Dest`-only or a single `/A` dict with exactly `/URI` (allowlisted) or
// `/GoTo`, with no /AA, no /Next and no annot-level /URI anywhere.
const keepsUriText = (text: string): boolean => {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (!["http:", "https:", "mailto:"].includes(url.protocol)) return false;
  return url.hostname.toLowerCase() !== "hreader-export.invalid";
};

interface ActionLit {
  readonly S?: string | undefined;
  readonly URI?: string | undefined;
  readonly Next?: ActionLit | ActionLit[] | undefined;
  readonly D?: number[] | undefined;
  readonly F?: string | undefined;
  readonly JS?: string | undefined;
}

interface AaLit {
  readonly E?: ActionLit | undefined;
  readonly X?: ActionLit | undefined;
  readonly D?: ActionLit | undefined;
  readonly U?: ActionLit | undefined;
  readonly Fo?: ActionLit | undefined;
  readonly Bl?: ActionLit | undefined;
}

interface AnnotLit {
  readonly Subtype: string;
  readonly A?: ActionLit | ActionLit[] | string | undefined;
  readonly Dest?: string | undefined;
  readonly AA?: AaLit | undefined;
  readonly URI?: string | undefined;
  readonly F?: number | undefined;
  readonly Border?: number[] | undefined;
  readonly StructParent?: number | undefined;
}

const actionLit = (a: ActionLit): Record<string, LitValue> => {
  const lit: Record<string, LitValue> = {};
  if (a.S !== undefined) lit["S"] = PDFName.of(a.S);
  if (a.URI !== undefined) lit["URI"] = PDFString.of(a.URI);
  if (a.Next !== undefined) {
    lit["Next"] = Array.isArray(a.Next) ? a.Next.map(actionLit) : actionLit(a.Next);
  }
  if (a.D !== undefined) lit["D"] = [...a.D];
  if (a.F !== undefined) lit["F"] = PDFString.of(a.F);
  if (a.JS !== undefined) lit["JS"] = PDFString.of(a.JS);
  return lit;
};

const annotLit = (a: AnnotLit): Record<string, LitValue> => {
  const lit: Record<string, LitValue> = {
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of(a.Subtype),
    Rect: [0, 0, 120, 20],
  };
  if (a.A !== undefined) {
    lit["A"] =
      typeof a.A === "string"
        ? PDFString.of(a.A)
        : Array.isArray(a.A)
          ? a.A.map(actionLit)
          : actionLit(a.A);
  }
  if (a.Dest !== undefined) lit["Dest"] = PDFName.of(a.Dest);
  if (a.AA !== undefined) {
    lit["AA"] = Object.fromEntries(
      Object.entries(a.AA)
        .filter(([, act]) => act !== undefined)
        .map(([trigger, act]) => [trigger, actionLit(act as ActionLit)]),
    );
  }
  if (a.URI !== undefined) lit["URI"] = PDFString.of(a.URI);
  if (a.F !== undefined) lit["F"] = a.F;
  if (a.Border !== undefined) lit["Border"] = [...a.Border];
  if (a.StructParent !== undefined) lit["StructParent"] = a.StructParent;
  return lit;
};

/** The spec predicate over the generated literal: exactly what the sanitizer must keep. */
const expectKeep = (a: AnnotLit): boolean => {
  if (a.Subtype !== "Link") return true;
  if (a.AA !== undefined) return false;
  if (a.URI !== undefined) return false;
  if (a.A === undefined) return a.Dest !== undefined;
  if (typeof a.A !== "object" || Array.isArray(a.A)) return false;
  if (a.A.Next !== undefined) return false;
  if (a.A.S === "URI") return a.A.URI !== undefined && keepsUriText(a.A.URI);
  return a.A.S === "GoTo";
};

describe("sanitizePdfLinks · generated Link shapes", () => {
  const safeUriArb = fc.constantFrom(
    "https://example.com/a",
    "http://ok.example/b",
    "mailto:x@y.z",
  );
  const badUriArb = fc.constantFrom(
    "file:///tmp/x",
    "FILE:///tmp/x",
    "javascript:alert(1)",
    "data:text/plain,eA==",
    "blob:https://x/y",
    "ftp://f/x",
    "img.png",
    "./r.png",
    "http://hreader-export.invalid/f/c",
    "https://HREADER-EXPORT.INVALID/f/c",
    "not a url",
    " file:///p",
  );
  const uriArb = fc.oneof(safeUriArb, badUriArb);
  const kindArb = fc.constantFrom(
    "URI",
    "GoTo",
    "JavaScript",
    "Launch",
    "GoToR",
    "SubmitForm",
    "Named",
    "Hide",
    "Rendition",
    "uri",
  );
  const nestedActionArb: fc.Arbitrary<ActionLit> = fc.record(
    {
      S: fc.option(kindArb, { nil: undefined }),
      URI: fc.option(uriArb, { nil: undefined }),
      F: fc.option(fc.constant("run.exe"), { nil: undefined }),
      JS: fc.option(fc.constant("x()"), { nil: undefined }),
    },
    { requiredKeys: [] },
  );
  const actionArb: fc.Arbitrary<ActionLit> = fc.record(
    {
      S: fc.option(kindArb, { nil: undefined }),
      URI: fc.option(uriArb, { nil: undefined }),
      Next: fc.option(
        fc.oneof(nestedActionArb, fc.array(nestedActionArb, { minLength: 1, maxLength: 3 })),
        { nil: undefined },
      ),
      D: fc.option(fc.constant([0, 0, 0]), { nil: undefined }),
      F: fc.option(fc.constant("run.exe"), { nil: undefined }),
      JS: fc.option(fc.constant("x()"), { nil: undefined }),
    },
    { requiredKeys: [] },
  );
  const aaArb: fc.Arbitrary<AaLit> = fc.record(
    {
      E: fc.option(nestedActionArb, { nil: undefined }),
      X: fc.option(nestedActionArb, { nil: undefined }),
      D: fc.option(nestedActionArb, { nil: undefined }),
      U: fc.option(nestedActionArb, { nil: undefined }),
      Fo: fc.option(nestedActionArb, { nil: undefined }),
      Bl: fc.option(nestedActionArb, { nil: undefined }),
    },
    { requiredKeys: [] },
  );
  const annotArb: fc.Arbitrary<AnnotLit> = fc.record(
    {
      Subtype: fc.constantFrom("Link", "Link", "Link", "Link", "Link", "Text", "link"),
      A: fc.option(
        fc.oneof(
          actionArb,
          fc.array(actionArb, { minLength: 1, maxLength: 2 }),
          fc.constant("not-a-dict"),
        ),
        { nil: undefined },
      ),
      Dest: fc.option(fc.constantFrom("sec", "top"), { nil: undefined }),
      AA: fc.option(aaArb, { nil: undefined }),
      URI: fc.option(uriArb, { nil: undefined }),
      F: fc.option(fc.integer({ min: 0, max: 8 }), { nil: undefined }),
      Border: fc.option(fc.constant([0, 0, 1]), { nil: undefined }),
      StructParent: fc.option(fc.integer({ min: 0, max: 9 }), { nil: undefined }),
    },
    { requiredKeys: ["Subtype"] },
  );

  it("should keep only spec-shape Links from random annotation dicts", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(annotArb, { minLength: 0, maxLength: 12 }), async (list) => {
        const bytes = await buildPdfOf((doc) => list.map((a) => doc.context.obj(annotLit(a))));
        const out = await sanitizePdfLinks(bytes);
        const expected = list.filter((a) => a.Subtype !== "Link" || expectKeep(a)).length;
        expect(await annotCountOf(out)).toBe(expected);
        // Cross-check: every surviving Link dict in the artifact satisfies the
        // same shape predicate, read back off the wire.
        const { document, links } = await survivingLinkDictsOf(out);
        for (const link of links) {
          const a = link.get(ACTION);
          const act = a instanceof PDFRef ? document.context.lookup(a) : a;
          const wireLit: AnnotLit = {
            Subtype: "Link",
            A:
              act instanceof PDFDict
                ? {
                    S: nameStringOf(act.get(KIND)),
                    URI: textStringOf(act.get(URI)),
                    Next: act.get(NEXT) !== undefined ? {} : undefined,
                  }
                : act === undefined
                  ? undefined
                  : "not-a-dict",
            Dest: link.get(DEST) !== undefined ? "x" : undefined,
            AA: link.get(AA) !== undefined ? {} : undefined,
            URI: link.get(URI) !== undefined ? "x" : undefined,
          };
          expect(expectKeep(wireLit)).toBe(true);
        }
      }),
      { numRuns: 120, seed: 451 },
    );
  });
});

const nameStringOf = (value: PDFObject | undefined): string | undefined =>
  value instanceof PDFName ? value.asString().slice(1) : undefined;

const textStringOf = (value: PDFObject | undefined): string | undefined =>
  value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : undefined;

describe("sanitizePdfLinks · pass-through and failure contract", () => {
  it("should return the original bytes when nothing needs removing", async () => {
    const bytes = await buildPdfOf((doc) => [
      uriAnnotOf(doc, "https://example.com/x.png"),
      uriAnnotOf(doc, "mailto:a@b.c"),
      destAnnotOf(doc, PDFName.of("sec")),
    ]);
    // Reference identity, not just equality: the no-strip path must not
    // re-serialize at all, so a clean managed export stays byte-identical.
    expect(await sanitizePdfLinks(bytes)).toBe(bytes);
  });

  it("should return the original bytes for a page without /Annots", async () => {
    const bytes = await buildPdfOf(() => []);
    expect(await sanitizePdfLinks(bytes)).toBe(bytes);
  });

  it("should fail closed with render_empty when the bytes cannot be parsed", async () => {
    const failure = await failureOf(Buffer.from("%PDF-1.4\n%%EOF\n"));
    expect(failure).toBeInstanceOf(HrError);
    expect((failure as HrError).code).toBe("render_empty");
  });
});
