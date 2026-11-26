// This layer: reads the PDF product's true values (page count + outline entry count); read-only — anything unparseable throws `render_empty`.
//
// Parsing is delegated to pdf-lib (`throwOnInvalidObject` strict mode: malformed bytes error immediately, no recovery,
// no console warnings); this layer only does semantics — enter the tree via the Catalog's `/Outlines`, walk
// entries via `/First`/`/Next` links, and reconcile against `/Count`.
//
// **Deliberately** shares no code with `tests/helpers/pdf-scan.ts`: that file is the test-side independent oracle —
// sharing it would let "src misreads, oracle misreads the same way" go green together.

import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef } from "pdf-lib";

import { HrError } from "@hreader/core";

import { firstErrorLineOf, messageOf } from "../errors";

const failOf = (reason: string): HrError =>
  new HrError("render_empty", `PDF 大纲结构解析不出：${reason}`);

interface PdfFacts {
  readonly pages: number;
  readonly outline: number;
}

/** Strict parsing: `throwOnInvalidObject` throws on malformed bytes on the spot (with no console.warn side effects). */
const loadOf = async (bytes: Uint8Array): Promise<PDFDocument> => {
  try {
    return await PDFDocument.load(bytes, { throwOnInvalidObject: true });
  } catch (error: unknown) {
    throw new HrError("render_empty", `PDF 结构解析不出：${firstErrorLineOf(messageOf(error))}`);
  }
};

const referenceOf = (entries: PDFDict, key: string): PDFRef | undefined => {
  const value = entries.get(PDFName.of(key));
  return value instanceof PDFRef ? value : undefined;
};

const nameOf = (entries: PDFDict, key: string): string | undefined => {
  const value = entries.get(PDFName.of(key));
  return value instanceof PDFName ? value.asString() : undefined;
};

const dictionaryOf = (document: PDFDocument, ref: PDFRef, what: string): PDFDict => {
  const value = document.context.lookup(ref);
  if (value === undefined) throw failOf(`找不到 ${what} 对象 ${String(ref.objectNumber)}`);
  if (!(value instanceof PDFDict)) {
    throw failOf(`${what} 对象 ${String(ref.objectNumber)} 不是字典`);
  }
  return value;
};

interface ItemsContext {
  readonly document: PDFDocument;
  /** Seen entry object numbers: the sole termination guard — in a legal walk each entry owns one object number, so a repeat means a cycle. */
  readonly seen: Set<number>;
}

/** `/Next` walks the sibling chain, `/First` descends a level; neither reference means end of chain — a normal finish. */
const countItemsOf = (context: ItemsContext, first: PDFRef | undefined): number => {
  let count = 0;
  let current = first;
  while (current !== undefined) {
    if (context.seen.has(current.objectNumber)) {
      throw failOf(`条目 ${String(current.objectNumber)} 被重复引用`);
    }
    context.seen.add(current.objectNumber);
    const entries = dictionaryOf(context.document, current, "大纲条目");
    // Wandering into the page tree would count page objects as bookmarks; do not wait for `/Count` to cover it — page count and outline count could coincide.
    const type = nameOf(entries, "Type");
    if (type === "/Page" || type === "/Pages") {
      throw failOf(`大纲条目 ${String(current.objectNumber)} 是页树节点（/Type ${type}）`);
    }
    count += 1 + countItemsOf(context, referenceOf(entries, "First"));
    current = referenceOf(entries, "Next");
  }
  return count;
};

/**
 * The entry count reports the **product's true value**: a `display: none` heading is still an `h1` in the print
 * sheet but Chrome generates no bookmark for it — only the product counts right. `/Count` is the generator's
 * self-report; the walk is structurally proven. If they disagree the product is self-contradictory, and picking
 * either number lies for it (an entry's `/Count` can be negative for collapsed state — take the absolute value).
 */
const outlineCountOf = (document: PDFDocument): number => {
  const outlines = referenceOf(document.catalog, "Outlines");
  // A missing key = this document has no outline (`--no-outline`, or simply no headings) — a normal path, not an error.
  if (outlines === undefined) return 0;
  const root = dictionaryOf(document, outlines, "/Outlines");
  const walked = countItemsOf({ document, seen: new Set() }, referenceOf(root, "First"));
  const declared = root.get(PDFName.of("Count"));
  if (declared instanceof PDFNumber && Math.abs(declared.asNumber()) !== walked) {
    throw failOf(
      `/Count 自报 ${String(Math.abs(declared.asNumber()))} 条，实走 ${String(walked)} 条`,
    );
  }
  return walked;
};

/**
 * Any unreadable structure (not a PDF, broken page-tree links, broken `/First`, `/Count` != walked count)
 * throws `render_empty` — never falls back to 0: falling back would disguise "Chrome changed its output
 * format" as "this document has no outline", the hardest kind of false green to hunt down.
 */
export const inspectPdfOf = async (bytes: Uint8Array): Promise<PdfFacts> => {
  const document = await loadOf(bytes);
  try {
    return { pages: document.getPageCount(), outline: outlineCountOf(document) };
  } catch (error: unknown) {
    if (error instanceof HrError) throw error;
    throw new HrError("render_empty", `PDF 结构解析不出：${firstErrorLineOf(messageOf(error))}`);
  }
};
