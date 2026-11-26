// Unit tests for the doc-directory capability book: cap minting shape,
// registration semantics, and the lookup contract `/f/` relies on.
// Timing safety is locked by code review (lookup delegates every comparison
// to `tokenMatches`, which is timingSafeEqual-based) plus the behavioral
// assertions below — no wall-clock assertions per AGENTS.md §9.

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ResolvedTarget } from "../../src/io/paths";
import { CAP_LENGTH, capabilityOf, createCapabilityBook } from "../../src/server/capability";

const WS = "/tmp/hr-cap-test-ws";

/** Synthetic targets: `register` only consumes `realPath` (dirname/basename) and `relative`. */
const targetOf = (relative: string): ResolvedTarget => ({
  realPath: join(WS, relative),
  relative,
  workspace: WS,
  storeDir: join(WS, ".hreader"),
  lockPath: join(WS, ".hreader", "locks", "x.lock"),
});

describe("capabilityOf", () => {
  it("should mint 22-char base64url caps", () => {
    const key = new Uint8Array(32).fill(7);
    const cap = capabilityOf(key, "page");
    expect(cap).toHaveLength(CAP_LENGTH);
    expect(cap).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  it("should be deterministic for the same key and directory", () => {
    const key = new Uint8Array(32).fill(9);
    expect(capabilityOf(key, "a/b")).toBe(capabilityOf(key, "a/b"));
  });

  it("should differ across keys for the same directory", () => {
    const a = new Uint8Array(32).fill(1);
    const b = new Uint8Array(32).fill(2);
    expect(capabilityOf(a, "page")).not.toBe(capabilityOf(b, "page"));
  });

  it("should differ across directories for the same key", () => {
    const key = new Uint8Array(32).fill(3);
    expect(capabilityOf(key, "a")).not.toBe(capabilityOf(key, "b"));
    expect(capabilityOf(key, "page")).not.toBe(capabilityOf(key, "page/sub"));
  });
});

describe("createCapabilityBook", () => {
  it("should hand the same cap to documents sharing one directory", () => {
    const book = createCapabilityBook();
    const first = book.register(targetOf("page/index.html"));
    const second = book.register(targetOf("page/other.html"));
    expect(second.cap).toBe(first.cap);
    expect(second.dir).toBe(first.dir);
    expect([...second.docs.keys()].sort()).toEqual(["index.html", "other.html"]);
  });

  it("should mint each cap from the directory path, never the file name", () => {
    const key = new Uint8Array(32).fill(5);
    const book = createCapabilityBook(key);
    expect(book.register(targetOf("page/index.html")).cap).toBe(capabilityOf(key, "page"));
    expect(book.register(targetOf("page/sub/doc.html")).cap).toBe(capabilityOf(key, "page/sub"));
    // A document at the workspace root mints over "".
    expect(book.register(targetOf("index.html")).cap).toBe(capabilityOf(key, ""));
  });

  it("should hand different caps to different directories", () => {
    const book = createCapabilityBook();
    const a = book.register(targetOf("a/index.html"));
    const b = book.register(targetOf("b/index.html"));
    expect(a.cap).not.toBe(b.cap);
    const root = book.register(targetOf("doc.html"));
    expect([a.cap, b.cap]).not.toContain(root.cap);
  });

  it("should resolve a registered cap to its own grant only", () => {
    const book = createCapabilityBook();
    const a = book.register(targetOf("a/x.html"));
    const b = book.register(targetOf("b/y.html"));
    expect(book.lookup(a.cap)).toBe(a);
    expect(book.lookup(b.cap)).toBe(b);
    // A cap names its own directory; it can never alias the other grant.
    expect(book.lookup(a.cap)?.dir).not.toBe(b.dir);
  });

  it("should miss on forged, truncated, extended and empty caps", () => {
    const book = createCapabilityBook();
    const grant = book.register(targetOf("page/index.html"));
    expect(book.lookup("A".repeat(CAP_LENGTH))).toBeUndefined();
    expect(book.lookup(grant.cap.slice(0, CAP_LENGTH - 1))).toBeUndefined();
    expect(book.lookup(`${grant.cap}x`)).toBeUndefined();
    expect(
      book.lookup(`${grant.cap.slice(0, -1)}${grant.cap.endsWith("A") ? "B" : "A"}`),
    ).toBeUndefined();
    expect(book.lookup("")).toBeUndefined();
    expect(book.lookup(grant.cap.toLowerCase())).toBeUndefined();
    expect(book.lookup(`${grant.cap}/style.css`)).toBeUndefined();
  });

  it("should miss on caps minted under a different key (restart invalidation)", () => {
    const first = createCapabilityBook();
    const second = createCapabilityBook();
    const grant = first.register(targetOf("page/index.html"));
    // A fresh book is a fresh key: every previously issued cap is dead, even
    // though the directory registers again under its *new* cap.
    expect(second.lookup(grant.cap)).toBeUndefined();
    const reissued = second.register(targetOf("page/index.html"));
    expect(reissued.cap).not.toBe(grant.cap);
    expect(second.lookup(grant.cap)).toBeUndefined();
  });

  it("should keep lookup exact even with many grants registered", () => {
    const book = createCapabilityBook();
    const grants = Array.from({ length: 32 }, (_, i) =>
      book.register(targetOf(`d${String(i)}/index.html`)),
    );
    for (const grant of grants) {
      expect(book.lookup(grant.cap)).toBe(grant);
      // Near-miss is still a miss, at any grant density.
      expect(book.lookup(grant.cap.slice(1))).toBeUndefined();
    }
  });

  it("should build frame URLs as /f/<cap>/<encoded basename>", () => {
    const book = createCapabilityBook();
    const url = book.frameUrlOf(targetOf("page/index.html"));
    const grant = book.register(targetOf("page/index.html"));
    expect(url).toBe(`/f/${grant.cap}/index.html`);
    // Basename is URL-encoded exactly once; the cap itself is already base64url-safe.
    const spaced = book.frameUrlOf(targetOf("page/a b.html"));
    expect(spaced).toBe(`/f/${grant.cap}/a%20b.html`);
    const paren = book.frameUrlOf(targetOf("page/a(1).html"));
    expect(paren).toBe(`/f/${grant.cap}/a(1).html`);
  });
});
