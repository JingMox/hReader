// Self-tests for the shared adversarial corpus: every entry must be a well-formed input
// (unique id, real `why`, exactly one representation) and must parse without throwing in
// parse5 — a corpus entry that crashes the parser tests the parser, not the feature.

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parse5 } from "parse5";
import { describe, expect, it } from "vitest";

import {
  balancedNestedHtml,
  MALFORMED_HTML,
  malformedHtmlText,
  nestedTagHtml,
  type MalformedHtmlEntry,
} from "./html-malformed.ts";
import {
  CASE_ONLY_PAIRS,
  HOSTILE_FILENAMES,
  HOSTILE_PATHS,
  type PathCase,
  symlinkEscapeFixture,
  type SymlinkEscapeFixture,
} from "./paths.ts";
import { paddedUrl, URL_CASES, type UrlCase } from "./urls.ts";
import { XSS_PAYLOADS, type XssCase } from "./xss.ts";

const uniqueIds = (ids: readonly string[]): boolean => new Set(ids).size === ids.length;

describe("MALFORMED_HTML", () => {
  it("should have unique ids and a non-empty why on every entry", () => {
    expect(uniqueIds(MALFORMED_HTML.map((entry) => entry.id))).toBe(true);
    for (const entry of MALFORMED_HTML) {
      expect(entry.why.length).toBeGreaterThan(0);
    }
  });

  it.each(MALFORMED_HTML.map((entry) => [entry.id, entry] as const))(
    "should parse without throwing under both scripting modes: %s",
    (_id, entry) => {
      const text = malformedHtmlText(entry);
      expect(() => parse5(text, { scriptingEnabled: false })).not.toThrow();
      expect(() => parse5(text, { scriptingEnabled: true })).not.toThrow();
    },
  );

  it("should decode byte entries through the mandated UTF-8 error handling (U+FFFD appears)", () => {
    const byteEntries: MalformedHtmlEntry[] = MALFORMED_HTML.filter((entry) => "bytes" in entry);
    expect(byteEntries.length).toBeGreaterThanOrEqual(3);
    for (const entry of byteEntries) {
      expect(malformedHtmlText(entry)).toContain("\uFFFD");
    }
  });

  it("should build depth stress through the nested-tag helpers", () => {
    expect(nestedTagHtml("div", 3)).toBe("<div><div><div>");
    expect(balancedNestedHtml("b", 3, "x")).toBe("<b><b><b>x</b></b></b>");
    const deep = MALFORMED_HTML.find((entry) => entry.id === "deep-nesting-5000");
    expect(deep === undefined ? "missing" : malformedHtmlText(deep)).toBe(
      nestedTagHtml("div", 5000),
    );
  });
});

describe("HOSTILE_PATHS and HOSTILE_FILENAMES", () => {
  it("should have unique ids and non-empty fields on every entry", () => {
    const lists: readonly (readonly PathCase[])[] = [HOSTILE_PATHS, HOSTILE_FILENAMES];
    for (const list of lists) {
      expect(uniqueIds(list.map((entry) => entry.id))).toBe(true);
      for (const entry of list) {
        expect(entry.path.length).toBeGreaterThan(0);
        expect(entry.why.length).toBeGreaterThan(0);
      }
    }
  });

  it("should keep the mandated attack shapes in the corpus", () => {
    const paths = HOSTILE_PATHS.map((entry) => entry.path);
    expect(paths).toContain("..");
    expect(paths).toContain("../x");
    expect(paths).toContain("%2e%2e");
    expect(paths).toContain("%2fetc%2fpasswd");
    expect(paths.some((path) => path.includes("\0"))).toBe(true);
    expect(paths.some((path) => path.length === 300)).toBe(true);
    expect(paths.some((path) => path.endsWith(".") || path.endsWith(" "))).toBe(true);
    expect(paths.some((path) => path.startsWith(".hreader/"))).toBe(true);

    const names = HOSTILE_FILENAMES.map((entry) => entry.path);
    expect(names.some((name) => name.includes("<img"))).toBe(true);
    expect(names.some((name) => name.includes("?"))).toBe(true);
    expect(names.some((name) => name.includes("#"))).toBe(true);
    expect(names.some((name) => name.includes("%"))).toBe(true);
    expect(names.some((name) => name.startsWith(".hreader/"))).toBe(true);
  });

  it("should offer case-only pairs that differ purely by letter case", () => {
    expect(CASE_ONLY_PAIRS.length).toBeGreaterThan(0);
    for (const [lower, upper] of CASE_ONLY_PAIRS) {
      expect(lower).not.toBe(upper);
      expect(lower.toLowerCase()).toBe(upper.toLowerCase());
    }
  });
});

describe("symlinkEscapeFixture", () => {
  it("should build a workspace whose links resolve outside it", () => {
    const base = mkdtempSync(join(tmpdir(), "hr-adv-corpus-test-"));
    try {
      const fixture: SymlinkEscapeFixture = symlinkEscapeFixture(base);
      expect(realpathSync(fixture.link)).toBe(realpathSync(fixture.outside));
      expect(realpathSync(fixture.fileLink)).toBe(realpathSync(fixture.outsideFile));
      expect(fixture.link.startsWith(fixture.workspace)).toBe(true);
      expect(fixture.outside.startsWith(fixture.workspace)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("XSS_PAYLOADS", () => {
  it("should have unique ids and keep the mandated payload shapes", () => {
    const cases: readonly XssCase[] = XSS_PAYLOADS;
    expect(uniqueIds(cases.map((entry) => entry.id))).toBe(true);
    const payloads = cases.map((entry) => entry.payload);
    expect(payloads.some((payload) => payload.includes("<img src=x onerror"))).toBe(true);
    expect(payloads.some((payload) => payload.includes("<svg onload"))).toBe(true);
    expect(payloads.some((payload) => payload.startsWith("</textarea><script>"))).toBe(true);
    expect(payloads.some((payload) => payload.startsWith("</mark><script>"))).toBe(true);
    expect(payloads.some((payload) => payload.startsWith("javascript:"))).toBe(true);
    expect(payloads.some((payload) => payload.toLowerCase().startsWith("vbscript:"))).toBe(true);
    expect(payloads.some((payload) => payload.startsWith("data:"))).toBe(true);
    expect(payloads.some((payload) => payload.includes("constructor.constructor"))).toBe(true);
    expect(payloads.some((payload) => payload.includes("\u202E"))).toBe(true);
    expect(payloads.some((payload) => payload.includes("\u200B"))).toBe(true);
    expect(payloads.some((payload) => payload.length >= 100_000)).toBe(true);
  });
});

describe("URL_CASES", () => {
  it("should have unique ids and a non-empty why on every entry", () => {
    const cases: readonly UrlCase[] = URL_CASES;
    expect(uniqueIds(cases.map((entry) => entry.id))).toBe(true);
    for (const entry of cases) {
      expect(entry.why.length).toBeGreaterThan(0);
    }
  });

  it("should pin the 2048/2049 boundary exactly through paddedUrl", () => {
    const byLength = new Map(URL_CASES.map((entry) => [entry.id, entry.url.length]));
    expect(byLength.get("len-2048")).toBe(2048);
    expect(byLength.get("len-2049")).toBe(2049);
    expect(URL_CASES.find((entry) => entry.id === "len-2048")?.url).toBe(
      paddedUrl("https://example.com/", 2048),
    );
    expect(paddedUrl("https://x/", 5)).toBe("https");
  });

  it("should keep scheme, credential, IDN and whitespace shapes", () => {
    const urls = URL_CASES.map((entry) => entry.url);
    expect(urls).toContain("//evil.example/x");
    expect(urls.some((url) => url.includes("user:pass@"))).toBe(true);
    expect(urls.some((url) => url.includes("例え"))).toBe(true);
    expect(urls.some((url) => url.includes("xn--"))).toBe(true);
    expect(urls.some((url) => url.startsWith("  "))).toBe(true);
    expect(urls.some((url) => /[\t\n]/.exec(url) !== null)).toBe(true);
    expect(urls).toContain("");
  });
});
