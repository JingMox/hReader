// This layer holds handwritten minimal PDF bytes (page tree + outline tree) as fixtures for `pdf-scan.test.ts` and `pdf-bookmarks.test.ts`; **test-only**.
//
// No real Chrome artifacts: real bytes drift with Chrome versions, and the three facts — page order / tree /
// decoding — cannot be pinned on them. Each handwritten piece pins one thing: single entry, three-level nesting, no `/Outlines`, a multi-level page tree, `/Kids` vs object numbers in reverse order.
//
// The `OUTLINE_*` pieces are trap fixtures for outline counts: the root's self-reported count **deliberately**
// disagrees with the real structure (or there is no structure at all) — they pin "never trust `/Count` directly, never fall back to 0 on a broken chain"; each one's specifics are in its own comment.
//
// Fixtures only serve the scanner: `/Size` and `startxref` exist to look PDF-shaped and are **not guaranteed
// consistent with the xref**, nor do they carry real content streams. Do not feed them to strict validators like qpdf / pdftotext — their complaints are not the scanner's bug.

/** Three-page skeleton: Catalog(1) + Pages(2) + Page(3..). Referenced page object numbers start at 3 so `/Dest` matches up. */
export const pagesOf = (count: number): string => {
  const pages = Array.from(
    { length: count },
    (_unused: unknown, index: number) =>
      `${String(3 + index)} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\n`,
  ).join("");
  const kids = Array.from(
    { length: count },
    (_unused: unknown, index: number) => `${String(3 + index)} 0 R`,
  ).join(" ");
  return (
    "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
    `2 0 obj\n<< /Type /Pages /Count ${String(count)} /Kids [${kids}] >>\nendobj\n` +
    pages
  );
};

/** Attach `/Outlines 10 0 R` to the Catalog: outline root and entries start at 10. */
export const withOutlinesOf = (body: string): string =>
  body.replace("/Type /Catalog /Pages 2 0 R", "/Type /Catalog /Pages 2 0 R /Outlines 10 0 R");

/** A classic xref trailer: `/Root` only appears here, so scanning the whole text for the first hit finds the Catalog. */
export const trailerOf = (): string =>
  "trailer\n<< /Size 99 /Root 1 0 R >>\nstartxref\n0000\n%%EOF\n";

export const bytesOf = (body: string): Uint8Array => Buffer.from(`${body}${trailerOf()}`, "latin1");

/**
 * The trailer also carries `/Info 30 0 R`: in real Chrome artifacts the `/Info` dictionary has its own `/Title`,
 * so "count `/Title` occurrences" is always +1; object 30 in this fixture is that trap.
 */
export const bytesWithInfoOf = (body: string): Uint8Array =>
  Buffer.from(
    `${body}30 0 obj\n<< /Title (Doc Title) >>\nendobj\n` +
      "trailer\n<< /Size 99 /Root 1 0 R /Info 30 0 R >>\nstartxref\n0000\n%%EOF\n",
    "latin1",
  );

/** Full artifact bytes: page tree + `count` sibling outline entries (with `count` 0 there is no `/Outlines` key at all). */
export const pdfWithBookmarksOf = (count: number): Uint8Array => {
  if (count === 0) return bytesOf(pagesOf(1));
  const refs = Array.from({ length: count }, (_unused: unknown, index: number) =>
    String(11 + index),
  );
  const items = refs
    .map((id: string, index: number) => {
      const next = refs[index + 1];
      const link = next === undefined ? "" : ` /Next ${next} 0 R`;
      return (
        `${id} 0 obj\n<< /Title (H${String(index + 1)}) /Parent 10 0 R${link}` +
        " /Dest [3 0 R /XYZ 0 800 0] >>\nendobj\n"
      );
    })
    .join("");
  const root =
    `10 0 obj\n<< /Type /Outlines /First 11 0 R /Last ${refs.at(-1) ?? ""} 0 R ` +
    `/Count ${String(count)} >>\nendobj\n`;
  return bytesOf(withOutlinesOf(pagesOf(1)) + root + items);
};

/** Single entry: root(10) → entry(11), pointing at page 2. */
export const SINGLE =
  "10 0 obj\n<< /Type /Outlines /First 11 0 R /Last 11 0 R /Count 1 >>\nendobj\n" +
  "11 0 obj\n<< /Title (Chapter One) /Parent 10 0 R /Dest [4 0 R /XYZ 0 800 0] >>\nendobj\n";

/**
 * Three-level nesting: root(10) → Part(11) → {Section A(12) → Sub A1(14), second level(13)}.
 * Sibling order deliberately differs from object-number order (12 → 13 via `/Next`, not by number).
 */
export const NESTED =
  "10 0 obj\n<< /Type /Outlines /First 11 0 R /Last 11 0 R /Count 4 >>\nendobj\n" +
  "11 0 obj\n<< /Title (Part) /Parent 10 0 R /First 12 0 R /Last 13 0 R /Count 3 " +
  "/Dest [3 0 R /XYZ 0 800 0] >>\nendobj\n" +
  "12 0 obj\n<< /Title (Section A) /Parent 11 0 R /First 14 0 R /Last 14 0 R /Count 1 " +
  "/Next 13 0 R /Dest [4 0 R /XYZ 0 700 0] >>\nendobj\n" +
  "13 0 obj\n<< /Title <FEFF7B2C4E8C5C42> /Parent 11 0 R /Prev 12 0 R " +
  "/Dest [5 0 R /XYZ 0 600 0] >>\nendobj\n" +
  "14 0 obj\n<< /Title (Sub A1) /Parent 12 0 R /Dest [5 0 R /XYZ 0 500 0] >>\nendobj\n";

/**
 * Four-level page tree: Catalog(1) → Pages(2) → Pages(3) → Pages(6) → Page(4), Page(5).
 * These two page-tree fixtures (this one and `REVERSED_KIDS`) exist for a **single reason**: pinning two
 * scanner mutations — ① flattening only one `/Kids` level, or appending intermediate `/Pages` into the page
 * order (objects 3/6 in `pages` is wrong); ② sorting by object number (this fixture happens to match object
 * order, so it only covers ①; ② is `REVERSED_KIDS`' job). The chain is deliberately four levels: at three,
 * "flatten one level" still yields the right answer and cannot reach the mutation.
 */
export const CHAIN_PAGES =
  "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
  "2 0 obj\n<< /Type /Pages /Count 2 /Kids [3 0 R] >>\nendobj\n" +
  "3 0 obj\n<< /Type /Pages /Parent 2 0 R /Count 2 /Kids [6 0 R] >>\nendobj\n" +
  "6 0 obj\n<< /Type /Pages /Parent 3 0 R /Count 2 /Kids [4 0 R 5 0 R] >>\nendobj\n" +
  "4 0 obj\n<< /Type /Page /Parent 6 0 R /MediaBox [0 0 595 842] >>\nendobj\n" +
  "5 0 obj\n<< /Type /Page /Parent 6 0 R /MediaBox [0 0 595 842] >>\nendobj\n";

/**
 * `/Kids [7 0 R 5 0 R]`: page order is the **reverse** of object-number order (object 5 first, 7 last).
 * This is the only fixture that goes red if `pageOrderOf` is changed to "sort by object number" — do not flip `/Kids` back to ascending.
 */
export const REVERSED_KIDS =
  "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
  "2 0 obj\n<< /Type /Pages /Count 2 /Kids [7 0 R 5 0 R] >>\nendobj\n" +
  "5 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\n" +
  "7 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\n";

/** Two siblings: 11 → 12 via `/Next`; 12 is the chain tail (no `/Next`). Without following `/Next` you count 1. */
export const OUTLINE_TWO_SIBLINGS =
  "10 0 obj\n<< /Type /Outlines /First 11 0 R /Last 12 0 R /Count 2 >>\nendobj\n" +
  "11 0 obj\n<< /Title (One) /Parent 10 0 R /Next 12 0 R /Dest [3 0 R /XYZ 0 800 0] >>\nendobj\n" +
  "12 0 obj\n<< /Title (Two) /Parent 10 0 R /Prev 11 0 R /Dest [4 0 R /XYZ 0 700 0] >>\nendobj\n";

/** The root self-reports `/Count 3` but really has 2: the artifact contradicts itself; picking either side is lying. */
export const OUTLINE_COUNT_LIE =
  "10 0 obj\n<< /Type /Outlines /First 11 0 R /Last 12 0 R /Count 3 >>\nendobj\n" +
  "11 0 obj\n<< /Title (One) /Parent 10 0 R /Next 12 0 R /Dest [3 0 R /XYZ 0 800 0] >>\nendobj\n" +
  "12 0 obj\n<< /Title (Two) /Parent 10 0 R /Prev 11 0 R /Dest [4 0 R /XYZ 0 700 0] >>\nendobj\n";

/** The root carries no `/Count` (optional per spec): the answer can only come from a real walk. */
export const OUTLINE_NO_COUNT =
  "10 0 obj\n<< /Type /Outlines /First 11 0 R /Last 11 0 R >>\nendobj\n" +
  "11 0 obj\n<< /Title (Only) /Parent 10 0 R /Dest [3 0 R /XYZ 0 800 0] >>\nendobj\n";

/** The root's `/Count` is negative (the collapsed-state spelling): cross-checks against a real walk must use its absolute value. */
export const OUTLINE_FOLDED_COUNT =
  "10 0 obj\n<< /Type /Outlines /First 11 0 R /Last 11 0 R /Count -1 >>\nendobj\n" +
  "11 0 obj\n<< /Title (Only) /Parent 10 0 R /Dest [3 0 R /XYZ 0 800 0] >>\nendobj\n";

/** `/First` points at nonexistent object 99: a broken chain must error, not fall back to 0. */
export const OUTLINE_BROKEN_FIRST =
  "10 0 obj\n<< /Type /Outlines /First 99 0 R /Last 99 0 R /Count 1 >>\nendobj\n";

/** The object `/First` points to is not a dictionary: same — must not be read as an "empty outline". */
export const OUTLINE_NOT_A_DICTIONARY =
  "10 0 obj\n<< /Type /Outlines /First 99 0 R /Last 99 0 R /Count 1 >>\nendobj\n" +
  "99 0 obj\n42\nendobj\n";

/** Self-loop: 11's `/Next` points back at itself. Without cycle detection this loops forever. */
export const OUTLINE_SELF_LOOP =
  "10 0 obj\n<< /Type /Outlines /First 11 0 R /Last 11 0 R /Count 1 >>\nendobj\n" +
  "11 0 obj\n<< /Title (Loop) /Parent 10 0 R /Next 11 0 R /Dest [3 0 R /XYZ 0 800 0] >>\nendobj\n";

/**
 * Title literals containing PDF structure: `(endobj)`, `(/First 99 0 R /Next 77 0 R /Count 999)`,
 * `(a \( b \) c (嵌套) 50% trailer << /Root 98 0 R >>)`. Real Chrome writes user titles verbatim into
 * `/Title`, so this is not a hostile artifact but a **legal document**; grep `/Next` on the raw text or split
 * objects at `endobj`, and this artifact reports "`/Count` claims 3 but the walk found 1" or fails to write at all.
 */
export const OUTLINE_HOSTILE_TITLES =
  "10 0 obj\n<< /Type /Outlines /First 11 0 R /Last 13 0 R /Count 3 >>\nendobj\n" +
  "11 0 obj\n<< /Title (endobj) /Parent 10 0 R /Next 12 0 R /Dest [3 0 R /XYZ 0 800 0] >>\nendobj\n" +
  "12 0 obj\n<< /Title (/First 99 0 R /Next 77 0 R /Count 999) /Parent 10 0 R " +
  "/Next 13 0 R /Dest [4 0 R /XYZ 0 700 0] >>\nendobj\n" +
  "13 0 obj\n<< /Title (a \\( b \\) c (nested (deep)) 50% trailer << /Root 98 0 R >>) " +
  "/Parent 10 0 R /Dest [5 0 R /XYZ 0 600 0] >>\nendobj\n";

/**
 * Nesting and siblings **mixed**, with `/Count` agreeing with the walk (5 total: A{A1,A2} and B{B1}).
 * Flattening one level, walking siblings only, or treating `/Next` as a child — every mutation goes red here
 * without needing the `/Count` mismatch as a net.
 */
export const OUTLINE_MIXED_NESTED_AND_SIBLINGS =
  "10 0 obj\n<< /Type /Outlines /First 11 0 R /Last 14 0 R /Count 5 >>\nendobj\n" +
  "11 0 obj\n<< /Title (A) /Parent 10 0 R /First 12 0 R /Last 13 0 R /Count 2 " +
  "/Next 14 0 R /Dest [3 0 R /XYZ 0 800 0] >>\nendobj\n" +
  "12 0 obj\n<< /Title (A1) /Parent 11 0 R /Next 13 0 R /Dest [3 0 R /XYZ 0 700 0] >>\nendobj\n" +
  "13 0 obj\n<< /Title (A2) /Parent 11 0 R /Dest [4 0 R /XYZ 0 600 0] >>\nendobj\n" +
  "14 0 obj\n<< /Title (B) /Parent 10 0 R /First 15 0 R /Last 15 0 R /Count 1 " +
  "/Dest [5 0 R /XYZ 0 500 0] >>\nendobj\n" +
  "15 0 obj\n<< /Title (B1) /Parent 14 0 R /Dest [5 0 R /XYZ 0 400 0] >>\nendobj\n";

/**
 * An entry body carrying `/Type /Page`: the walk stepped into the page tree. It must error on the spot — page
 * count and outline count may coincidentally match, so a `/Count` cross-check cannot catch this.
 */
export const OUTLINE_PAGE_NODE =
  "10 0 obj\n<< /Type /Outlines /First 11 0 R /Last 11 0 R /Count 1 >>\nendobj\n" +
  "11 0 obj\n<< /Type /Page /Parent 10 0 R /Dest [3 0 R /XYZ 0 800 0] >>\nendobj\n";

/** After the real trailer, append a fake trailer in **comment** form: `trailer`/`/Root` inside a comment must not be taken as real. */
export const bytesWithTrailerCommentOf = (body: string): Uint8Array =>
  Buffer.from(`${body}${trailerOf()}% trailer << /Root 99 0 R >>\n`, "latin1");

/**
 * After the real trailer (which already has `startxref`/`%%EOF`), write a **non-comment** trailer: it is not a
 * comment, so it scans as a second `PdfTrailer` and can only be filtered out by "positioned before the last
 * `startxref`"; without the filter it would pick up `/Root 99 0 R`.
 */
export const bytesWithTrailingTrailerOf = (body: string): Uint8Array =>
  Buffer.from(`${body}${trailerOf()}trailer\n<< /Size 99 /Root 99 0 R >>\n`, "latin1");

/**
 * A content stream containing bytes meant to mislead a parser: a bare `1 0 obj` rebirths the Catalog (or points
 * `/Outlines` at 99), and `99 0 obj`'s outline points at nonexistent 98. If the scanner does not skip to
 * `endstream` after `stream`, it reads stream contents as structure and reports "outline entry object 98 not
 * found" — so this fixture pins "skip streams", not "an endobj inside a stream is harmless".
 */
export const OUTLINE_STREAM_TRAP =
  "900 0 obj\n<< /Length 156 >>\nstream\n" +
  "1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Outlines 99 0 R >>\nendobj\n" +
  "99 0 obj\n<< /Type /Outlines /First 98 0 R /Last 98 0 R /Count 5 >>\nendobj\n" +
  "endstream\nendobj\n";

/** Object number 1 has generation 5 (not 0): the reference reads `1 5 R`; locating only honors the object number. */
export const bytesWithGenerationOf = (body: string): Uint8Array =>
  Buffer.from(
    body.replace("1 0 obj", "1 5 obj") +
      "trailer\n<< /Size 99 /Root 1 5 R >>\nstartxref\n0000\n%%EOF\n",
    "latin1",
  );
