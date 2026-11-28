// Self-tests for the malformed-HTML generator: same seed must reproduce the same
// document sequence (otherwise a found counter-example cannot be replayed), and every
// generated document must still be parseable — a generator that crashes the parser
// would only ever test parse5, never the feature under test.

import fc from "fast-check";
import { parse as parse5 } from "parse5";
import { describe, expect, it } from "vitest";

import { malformedHtmlArb, malformedHtmlSample } from "./html-generator.ts";

describe("malformedHtmlSample", () => {
  it("should reproduce the identical sequence for the same seed", () => {
    expect(malformedHtmlSample(42, 20)).toEqual(malformedHtmlSample(42, 20));
    expect(malformedHtmlSample(0, 20)).toEqual(malformedHtmlSample(0, 20));
  });

  it("should produce different sequences for different seeds", () => {
    expect(malformedHtmlSample(42, 20)).not.toEqual(malformedHtmlSample(43, 20));
  });

  it("should produce only parseable documents across several seeds", () => {
    for (const seed of [1, 7, 42, 999]) {
      for (const html of malformedHtmlSample(seed, 10)) {
        expect(() => parse5(html, { scriptingEnabled: false })).not.toThrow();
        expect(() => parse5(html, { scriptingEnabled: true })).not.toThrow();
      }
    }
  });

  it("should be a deterministic wrapper over malformedHtmlArb", () => {
    expect(fc.sample(malformedHtmlArb, { seed: 42, numRuns: 10 })).toEqual(
      malformedHtmlSample(42, 10),
    );
  });

  it("should include hostile fragments in the generated space (not just plain text)", () => {
    const corpus = malformedHtmlSample(42, 50).join("\n");
    expect(corpus).toMatch(/<\/?(div|table|xmp|template|svg|plaintext)/u);
    expect(corpus).toMatch(/&amp;|&#x?[0-9A-Fa-f]+;|&fake;/u);
  });
});
