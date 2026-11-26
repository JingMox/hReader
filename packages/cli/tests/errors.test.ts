// This layer covers `errors.ts` message convergence (first-line truncation / unknown normalization); pure functions, zero I/O.
import { describe, expect, it } from "vitest";

import { HrError } from "@hreader/core";

import { HintedError, firstErrorLineOf, messageOf } from "../src/errors";

describe("firstErrorLineOf", () => {
  it("should take the first non-empty line (skipping leading blank lines)", () => {
    expect(firstErrorLineOf("\n\n  \nfirst\nsecond")).toBe("first");
  });

  it("should return an empty string when input is all whitespace", () => {
    expect(firstErrorLineOf("")).toBe("");
    expect(firstErrorLineOf("\n\n")).toBe("");
  });

  it("should truncate a line longer than 200 chars to 200", () => {
    const long = "x".repeat(250);
    expect(firstErrorLineOf(long)).toHaveLength(200);
  });
});

describe("messageOf", () => {
  it("should take message from an Error", () => {
    expect(messageOf(new Error("boom"))).toBe("boom");
  });

  it("should normalize a non-Error through String", () => {
    expect(messageOf("plain")).toBe("plain");
    expect(messageOf(42)).toBe("42");
  });
});

describe("HintedError", () => {
  it("should keep the wrapped error's code, message and data", () => {
    const base = new HrError("invalid_selector", "bad", {
      data: { reason: "syntax", count: 3 },
    });
    const wrapped = new HintedError(base, "hint\n");

    expect(wrapped).toBeInstanceOf(HrError);
    expect(wrapped.code).toBe("invalid_selector");
    expect(wrapped.message).toBe("bad");
    expect(wrapped.data).toEqual({ reason: "syntax", count: 3 });
    expect(wrapped.hint).toBe("hint\n");
    expect(wrapped.cause).toBe(base);
  });

  it("should omit the data key when the wrapped error has none", () => {
    const wrapped = new HintedError(new HrError("invalid_document", "nope"), "hint\n");

    expect(wrapped.data).toBeUndefined();
  });
});
