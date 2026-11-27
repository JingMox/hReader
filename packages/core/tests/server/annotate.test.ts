// This layer owns the annotate-mode pure pieces: the single-use token book
// (TTL / single burn / binding / capacity / collision redraw), the
// `<script nonce>` injection point (after the doctype or byte 0), and the
// annotate CSP sweep across all four permission rows.

import { describe, expect, it } from "vitest";

import {
  ANNOTATE_TOKEN_LIMIT,
  ANNOTATE_TOKEN_TTL_MS,
  annotateNonce,
  annotatorTagOf,
  ANNOTATOR_NAME,
  createAnnotateTokenBook,
  injectAnnotator,
} from "../../src/server/annotate";
import { annotateCspOf, foreignCspOf } from "../../src/server/handlers";
import type { EffectivePermissions } from "../../src/io/permissions";
import { codeOf, fixedClock } from "../io/harness";

const START = 1_700_000_000_000;

const bookOf = (
  start = START,
): { book: ReturnType<typeof createAnnotateTokenBook>; advance: (ms: number) => void } => {
  const { clock, advance } = fixedClock(start);
  return { book: createAnnotateTokenBook(clock), advance };
};

describe("annotate token book · mint/consume", () => {
  it("should mint 22-char base64url tokens that consume once", () => {
    const { book } = bookOf();
    const token = book.mint("cap-a", "doc.html");

    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    expect(book.consume("cap-a", "doc.html", token)).toBe(true);
    // Single use: the second consume must find nothing, not "already used".
    expect(book.consume("cap-a", "doc.html", token)).toBe(false);
  });

  it("should mint a different token each call", () => {
    const { book } = bookOf();
    expect(book.mint("cap-a", "a.html")).not.toBe(book.mint("cap-a", "a.html"));
  });

  it("should bind to (cap, docName): a wrong half burns the token anyway", () => {
    const { book } = bookOf();
    const token = book.mint("cap-a", "doc.html");

    expect(book.consume("cap-b", "doc.html", token)).toBe(false);
    // Burned by the failed probe — the real holder can no longer use it.
    expect(book.consume("cap-a", "doc.html", token)).toBe(false);
  });

  it("should refuse a token minted for a sibling document", () => {
    const { book } = bookOf();
    const token = book.mint("cap-a", "doc.html");

    expect(book.consume("cap-a", "other.html", token)).toBe(false);
  });

  it("should treat a forged token exactly like a spent one: same false, same shape", () => {
    const { book } = bookOf();
    expect(book.consume("cap-a", "doc.html", "forged________________x")).toBe(false);
    expect(book.consume("cap-a", "doc.html", "")).toBe(false);
  });
});

describe("annotate token book · TTL", () => {
  it("should accept a token inside the TTL and refuse it past it", () => {
    const { book, advance } = bookOf();
    const fresh = book.mint("cap-a", "doc.html");
    const expiring = book.mint("cap-a", "doc.html");

    advance(ANNOTATE_TOKEN_TTL_MS - 1);
    expect(book.consume("cap-a", "doc.html", fresh)).toBe(true);

    advance(1);
    expect(book.consume("cap-a", "doc.html", expiring)).toBe(false);
  });

  it("should sweep expired entries on mint before checking the cap", () => {
    const { book, advance } = bookOf();
    for (let index = 0; index < ANNOTATE_TOKEN_LIMIT; index += 1) book.mint("cap-a", "doc.html");
    // The book is full of live tokens…
    advance(ANNOTATE_TOKEN_TTL_MS + 1);
    // …but they all expired, so minting again must succeed.
    expect(() => book.mint("cap-a", "doc.html")).not.toThrow();
  });

  it("should refuse minting past the live-token cap", () => {
    const { book } = bookOf();
    for (let index = 0; index < ANNOTATE_TOKEN_LIMIT; index += 1) book.mint("cap-a", "doc.html");

    expect(codeOf(() => book.mint("cap-a", "doc.html"))).toBe("busy");
  });

  it("should not let consuming an expired token free a slot by burning — expiry already did", () => {
    const { book, advance } = bookOf();
    const token = book.mint("cap-a", "doc.html");
    advance(ANNOTATE_TOKEN_TTL_MS + 1);

    expect(book.consume("cap-a", "doc.html", token)).toBe(false);
  });

  it("should sweep an entry that expires exactly at the boundary, freeing its slot", () => {
    const { book, advance } = bookOf();
    for (let index = 0; index < ANNOTATE_TOKEN_LIMIT; index += 1) book.mint("cap-a", "doc.html");
    // expiresAt === now is dead on both sides: consume's `>` refuses it, so the
    // sweep must not let it hold a slot hostage for one more round.
    advance(ANNOTATE_TOKEN_TTL_MS);
    expect(() => book.mint("cap-a", "doc.html")).not.toThrow();
  });
});

describe("annotate token book · collisions", () => {
  it("should retry on a collision and never rebind an existing token", () => {
    const { clock } = fixedClock(START);
    const issued = ["same", "same", "fresh"];
    let calls = 0;
    const book = createAnnotateTokenBook(clock, () => {
      const value = issued[Math.min(calls, issued.length - 1)] ?? "fresh";
      calls += 1;
      return value;
    });

    book.mint("cap-a", "a.html"); // "same"
    calls = 0;
    const second = book.mint("cap-a", "b.html"); // collides twice, then "fresh"
    expect(second).toBe("fresh");
    // The first token keeps its own binding — a collision must never rebind it.
    expect(book.consume("cap-a", "a.html", "same")).toBe(true);
  });

  it("should throw busy when the generator cannot produce a fresh token", () => {
    const { clock } = fixedClock(START);
    const book = createAnnotateTokenBook(clock, () => "stuck");
    book.mint("cap-a", "a.html");

    expect(codeOf(() => book.mint("cap-a", "b.html"))).toBe("busy");
  });

  it("should give up after exactly COLLISION_ATTEMPTS draws, never one more", () => {
    const { clock } = fixedClock(START);
    let draws = 0;
    const book = createAnnotateTokenBook(clock, () => {
      draws += 1;
      return "stuck";
    });
    book.mint("cap-a", "a.html");
    draws = 0;

    expect(codeOf(() => book.mint("cap-a", "b.html"))).toBe("busy");
    // One initial draw + 7 retries = 8; the bound is the contract, not a mood.
    expect(draws).toBe(8);
  });
});

describe("annotate nonce", () => {
  it("should be a fresh 22-char base64url value per call", () => {
    const first = annotateNonce();
    expect(first).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    expect(annotateNonce()).not.toBe(first);
  });
});

const TAG = (cap: string, nonce: string): string =>
  `<script nonce="${nonce}" src="/f/${cap}/${ANNOTATOR_NAME}" defer></script>`;

const tagIn = (html: string): { before: string; after: string } => {
  const injected = injectAnnotator(html, "cap-a", "nonce-a");
  const at = injected.indexOf(TAG("cap-a", "nonce-a"));
  return {
    before: injected.slice(0, at),
    after: injected.slice(at + TAG("cap-a", "nonce-a").length),
  };
};

describe("injectAnnotator · position", () => {
  it("should land at byte 0 when the document has no doctype", () => {
    const { before, after } = tagIn("<html><body>x</body></html>");
    expect(before).toBe("");
    expect(after).toBe("<html><body>x</body></html>");
  });

  it("should land immediately after a plain doctype", () => {
    const { before, after } = tagIn("<!doctype html><html><body>x</body></html>");
    expect(before).toBe("<!doctype html>");
    expect(after).toBe("<html><body>x</body></html>");
  });

  it("should honor uppercase and whitespace-padded doctypes", () => {
    expect(tagIn("<!DOCTYPE   html   >x").before).toBe("<!DOCTYPE   html   >");
    expect(tagIn("<!doctype\r\nhtml>x").before).toBe("<!doctype\r\nhtml>");
  });

  it("should place the tag after the doctype even when a comment precedes it", () => {
    const { before } = tagIn("<!-- head --><!doctype html><p>x");
    expect(before).toBe("<!-- head --><!doctype html>");
  });

  it("should fall back to byte 0 when a BOM hides the doctype", () => {
    // A BOM before the doctype is a parse error (quirks anyway); the tag still
    // leads the bytes, so a dangling-markup attack cannot swallow it.
    const { before, after } = tagIn("\uFEFF<!doctype html><p>x");
    expect(before).toBe("");
    expect(after).toBe("\uFEFF<!doctype html><p>x");
  });

  it("should keep a mid-document doctype-shaped comment out of the position hunt", () => {
    const { before } = tagIn("<p>x</p><!-- not a doctype -->");
    expect(before).toBe("");
  });

  it("should inject before leading whitespace and comments", () => {
    const { before } = tagIn("\r\n  <!-- c -->x");
    expect(before).toBe("");
  });

  it("should fall back to byte 0 when markup precedes the doctype", () => {
    const { before } = tagIn("x<!doctype html><p>y");
    expect(before).toBe("");
  });

  it("should survive a dangling-markup tail: the tag is closed before page bytes", () => {
    const { before } = tagIn('<!doctype html><p>x<script src="https://x/?');
    expect(before).toBe("<!doctype html>");
  });

  it("should inject into a 10 MB document", () => {
    const html = `<!doctype html><p>${"x".repeat(10 * 1024 * 1024)}</p>`;
    const injected = injectAnnotator(html, "cap-a", "nonce-a");
    expect(injected.startsWith(`<!doctype html>${TAG("cap-a", "nonce-a")}`)).toBe(true);
  });

  it("should never contain a page-controlled string inside the tag", () => {
    // The tag is a fixed three-attribute shape — the only moving parts are
    // the server-issued cap (base64url) and nonce (base64url).
    expect(annotatorTagOf("cap-a", "nonce-a")).toBe(
      `<script nonce="nonce-a" src="/f/cap-a/${ANNOTATOR_NAME}" defer></script>`,
    );
  });
});

describe("annotateCspOf · over the whole matrix", () => {
  const effective = (scripts: boolean, network: boolean): EffectivePermissions => ({
    scripts,
    network,
    scriptsSource: "doc",
    networkSource: "doc",
  });
  const combos: readonly (readonly [string, EffectivePermissions])[] = [
    ["scripts-off network-off", effective(false, false)],
    ["scripts-off network-on", effective(false, true)],
    ["scripts-on network-off", effective(true, false)],
    ["scripts-on network-on", effective(true, true)],
  ];

  for (const [label, perms] of combos) {
    it(`should differ only in the two directives when scripts are off (${label})`, () => {
      const normal = foreignCspOf(perms);
      const annotated = annotateCspOf(perms, "nonce-a");
      const normalDirectives = normal.split("; ");
      const annotatedDirectives = annotated.split("; ");

      expect(annotatedDirectives).toHaveLength(normalDirectives.length);
      const diffs = annotatedDirectives.filter(
        (directive, index) => directive !== normalDirectives[index],
      );
      if (perms.scripts) {
        expect(diffs).toHaveLength(0);
        expect(annotated).toBe(normal);
      } else {
        expect(diffs).toHaveLength(2);
        expect(annotated).toContain("script-src 'nonce-nonce-a'");
        expect(annotated).not.toContain("script-src 'none'");
        expect(annotated).toContain("sandbox allow-scripts");
        expect(annotated).not.toContain("script-src 'unsafe-inline'");
      }
      // Universal invariants, every row: opaque-origin sandbox, no same-origin key.
      expect(annotated).not.toContain("allow-same-origin");
      expect(annotated).toContain("frame-ancestors 'self'");
    });
  }

  it("should embed the actual nonce, not a placeholder", () => {
    const csp = annotateCspOf(effective(false, false), "RANDOMNONCE");
    expect(csp).toContain("script-src 'nonce-RANDOMNONCE'");
  });
});
