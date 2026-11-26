// This layer reads page order and the outline tree out of PDF bytes (**test-only**, never enters `src`); it writes no PDF and exports no runtime dependency.
//
// It is an **independent oracle** for `src/pdf/bookmarks.ts`: the two deliberately share no code, otherwise
// "src misreads" and "oracle misreads" would be wrong together and green together; neither side may copy the other when it changes.
//
// It only handles Chrome's artifact shape: classic xref table + trailer (`/Size … /Root … 0 R`), page objects
// directly addressable, no ObjStm / no XRef streams. The method is "find `N 0 obj … endobj` dictionaries + follow `/Kids`", not a general PDF parser.
//
// Known blind spot (**deliberately not fixed alongside `src`**, or both sides would be wrong together): objects
// are split at an `endobj` regex and `/Key`s grepped in object bodies, so artifacts with `endobj` / `/Next` inside
// title literals (`OUTLINE_HOSTILE_TITLES`) defeat this oracle. Those are pinned only by `pdf-bookmarks.test.ts` and the real-machine e2e — do not cross-check against this file.

/** All bytes of one object number (the dictionary/stream raw text before `endobj`), latin1-decoded: the PDF structure layer is single-byte. */
type PdfObjects = ReadonlyMap<number, string>;

/** An outline entry: `page` is the 1-based page order (`/Kids` array position + 1), not an object number. */
export interface PdfOutlineNode {
  readonly title: string;
  readonly page: number;
  readonly children: readonly PdfOutlineNode[];
}

export interface PdfScan {
  /** `/Pages` → `/Kids` flattened into page-object order (array index + 1 is the page order). */
  readonly pages: readonly number[];
  /** `undefined` when the Catalog has no `/Outlines` key (that is what a heading-less document looks like). */
  readonly outline: readonly PdfOutlineNode[] | undefined;
  /** The outline root's self-reported `/Count` (may be negative): lets the e2e triangulate "walk == `/Count` == printout heading count". */
  readonly outlineCount: number | undefined;
}

const OBJECT = /(\d+) 0 obj\b([\s\S]*?)endobj/gu;

const REF = (body: string, key: string): number | undefined => {
  const match = new RegExp(`/${key}\\s+(\\d+) 0 R`, "u").exec(body);
  return match?.[1] === undefined ? undefined : Number(match[1]);
};

/** Object number → raw text; `trailer` lives outside any `obj…endobj` and is read separately by `catalogOf`. */
const objectsFromTextOf = (text: string): PdfObjects => {
  const objects = new Map<number, string>();
  for (const match of text.matchAll(OBJECT)) {
    objects.set(Number(match[1]), match[2] ?? "");
  }
  return objects;
};

const textOf = (bytes: Uint8Array): string => new TextDecoder("latin1").decode(bytes);

const requireOf = (objects: PdfObjects, id: number, what: string): string => {
  const body = objects.get(id);
  if (body === undefined)
    throw new Error(`cannot find ${what} object ${String(id)} 0 R in the PDF`);
  return body;
};

/** `/Root` is written in the trailer (inside no object body): scan the whole text and take the first hit. */
const catalogOf = (text: string, objects: PdfObjects): string => {
  const rootId = /\/Root\s+(\d+) 0 R/u.exec(text)?.[1];
  if (rootId === undefined) throw new Error("no /Root in the PDF trailer");
  return requireOf(objects, Number(rootId), "/Root");
};

/** `/Kids` flattened recursively: page-tree nodes carry `/Kids`; leaf page objects carry `/Type /Page`. */
const pageOrderOf = (objects: PdfObjects, id: number): readonly number[] => {
  const body = requireOf(objects, id, "/Kids");
  const kids = /\/Kids\s*\[([^\]]*)\]/u.exec(body);
  if (kids === null) return [id];
  return [...(kids[1] ?? "").matchAll(/(\d+) 0 R/gu)].flatMap((match) =>
    pageOrderOf(objects, Number(match[1])),
  );
};

/** The `/Title` text string: Chrome writes `<FEFF…>` (UTF-16BE) for non-ASCII titles, `(…)` literals otherwise. */
const decodeHexOf = (hex: string): string => {
  const digits = hex.replaceAll(/\s/gu, "");
  const bytes: number[] = [];
  for (let index = 0; index + 1 < digits.length; index += 2) {
    bytes.push(Number.parseInt(digits.slice(index, index + 2), 16));
  }
  // `<FEFF…>`: after the BOM comes a UTF-16BE two-byte sequence (high byte first).
  const start = bytes[0] === 0xfe && bytes[1] === 0xff ? 2 : 0;
  let text = "";
  for (let index = start; index + 1 < bytes.length; index += 2) {
    text += String.fromCharCode(((bytes[index] ?? 0) << 8) | (bytes[index + 1] ?? 0));
  }
  return text;
};

const LITERAL_ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  r: "\r",
  t: "\t",
  b: "\b",
  f: "\f",
  "(": "(",
  ")": ")",
  "\\": "\\",
};

/** Literal-string escapes: `\(` `\)` `\\` and `\ddd` octal; any other `\x` yields `x` per spec. */
const decodeLiteralOf = (literal: string): string =>
  literal.replaceAll(/\\(\d{1,3}|[\s\S])/gu, (_whole: string, escape: string) =>
    /^\d+$/u.test(escape)
      ? String.fromCharCode(Number.parseInt(escape, 8))
      : (LITERAL_ESCAPES[escape] ?? escape),
  );

const titleOf = (body: string): string => {
  const hex = /\/Title\s*<([0-9A-Fa-f\s]*)>/u.exec(body);
  if (hex !== null) return decodeHexOf(hex[1] ?? "");
  const literal = /\/Title\s*\(((?:\\.|[^()\\])*)\)/su.exec(body);
  if (literal !== null) return decodeLiteralOf(literal[1] ?? "");
  throw new Error("outline entry has no /Title");
};

/** The destination's first element is the page object reference; `/Dest` may also live inside `/A << /D [...] >>`. Any other shape errors — a fallback branch would be dead code. */
const pageRefOf = (body: string): number => {
  const dest = /\/Dest\s*\[([^\]]*)\]/u.exec(body) ?? /\/D\s*\[([^\]]*)\]/u.exec(body);
  if (dest?.[1] === undefined) throw new Error("大纲条目没有 /Dest（或 /A << /D [...] >>）");
  const first = /^\s*(\d+) 0 R/u.exec(dest[1]);
  if (first?.[1] === undefined) throw new Error(`/Dest 首元素不是页对象引用：${dest[1]}`);
  return Number(first[1]);
};

interface ItemContext {
  readonly objects: PdfObjects;
  readonly pages: readonly number[];
}

/**
 * Walk the sibling chain along `/First` → `/Next`, recursing into each level's child chain; `/Parent` is used
 * to verify "children really point back to this parent". The outline root and entries are plain dictionaries
 * (entries have no `/Type`), so only references are honored, never type names.
 */
const itemsOf = (
  context: ItemContext,
  firstId: number | undefined,
  parentId: number,
): readonly PdfOutlineNode[] => {
  const nodes: PdfOutlineNode[] = [];
  let currentId = firstId;
  while (currentId !== undefined) {
    const body = requireOf(context.objects, currentId, "outline entry");
    const declared = REF(body, "Parent");
    if (declared !== parentId) {
      throw new Error(
        `大纲条目的 /Parent 不是 ${String(parentId)} 0 R（实际 ${String(declared)} 0 R）`,
      );
    }
    const pageRef = pageRefOf(body);
    const page = context.pages.indexOf(pageRef);
    if (page < 0) throw new Error(`/Dest 指向的 ${String(pageRef)} 0 R 不在 /Kids 页序里`);
    nodes.push({
      title: titleOf(body),
      page: page + 1,
      children: itemsOf(context, REF(body, "First"), currentId),
    });
    currentId = REF(body, "Next");
  }
  return nodes;
};

/** The outline root's self-reported `/Count`: `undefined` when the key is absent (it is optional on the root). */
const countOf = (body: string): number | undefined => {
  const match = /\/Count\s+(-?\d+)/u.exec(body);
  return match?.[1] === undefined ? undefined : Number(match[1]);
};

/** Read page order and the outline tree out of artifact bytes; with no `/Outlines` key both `outline` and `outlineCount` are `undefined`. */
export const pdfScanOf = (bytes: Uint8Array): PdfScan => {
  const text = textOf(bytes);
  const objects = objectsFromTextOf(text);
  const catalog = catalogOf(text, objects);
  const pagesId = REF(catalog, "Pages");
  if (pagesId === undefined) throw new Error("no /Pages in the PDF Catalog");
  const pages = pageOrderOf(objects, pagesId);
  const outlineId = REF(catalog, "Outlines");
  if (outlineId === undefined) return { pages, outline: undefined, outlineCount: undefined };
  const root = requireOf(objects, outlineId, "/Outlines");
  return {
    pages,
    outline: itemsOf({ objects, pages }, REF(root, "First"), outlineId),
    outlineCount: countOf(root),
  };
};
