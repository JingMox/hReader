// This layer covers `annotator/proto` inbound validation — shape, key sets and
// limits for parent→frame commands; every malformed payload must be silently
// dropped (`undefined`).

import { describe, expect, it } from "vitest";

import { parseAnnotatorCommand } from "../src/annotator/proto.ts";

const ITEM = { id: "an-1", start: 0, end: 5, status: "pending" };

describe("annotator proto · parseAnnotatorCommand", () => {
  it("should parse a highlights command", () => {
    expect(
      parseAnnotatorCommand({ type: "hr-annotator/highlights", version: 1, items: [ITEM] }),
    ).toEqual({ kind: "highlights", items: [ITEM] });
    expect(
      parseAnnotatorCommand({ type: "hr-annotator/highlights", version: 1, items: [] }),
    ).toEqual({ kind: "highlights", items: [] });
  });

  it("should drop malformed highlights commands", () => {
    const base = { type: "hr-annotator/highlights", version: 1, items: [ITEM] };
    expect(parseAnnotatorCommand({ ...base, version: 2 })).toBeUndefined();
    expect(parseAnnotatorCommand({ ...base, extra: 1 })).toBeUndefined();
    expect(parseAnnotatorCommand({ ...base, items: "x" })).toBeUndefined();
    expect(
      parseAnnotatorCommand({
        ...base,
        items: Array.from({ length: 10_001 }, () => ITEM),
      }),
    ).toBeUndefined();
  });

  it("should drop items with bad shapes or out-of-bounds fields", () => {
    const items = (item: unknown) =>
      parseAnnotatorCommand({ type: "hr-annotator/highlights", version: 1, items: [item] });
    expect(items(null)).toBeUndefined();
    expect(items("x")).toBeUndefined();
    expect(items({ ...ITEM, extra: 1 })).toBeUndefined();
    expect(items({ ...ITEM, id: "" })).toBeUndefined();
    expect(items({ ...ITEM, id: "x".repeat(257) })).toBeUndefined();
    expect(items({ ...ITEM, id: 3 })).toBeUndefined();
    expect(items({ ...ITEM, start: -1 })).toBeUndefined();
    expect(items({ ...ITEM, start: 0.5 })).toBeUndefined();
    expect(items({ ...ITEM, start: "0" })).toBeUndefined();
    expect(items({ ...ITEM, end: -2 })).toBeUndefined();
    expect(items({ ...ITEM, status: "otro" })).toBeUndefined();
    expect(items({ ...ITEM, status: 1 })).toBeUndefined();
    expect(items({ ...ITEM, status: "resolved" })).toEqual({
      kind: "highlights",
      items: [{ ...ITEM, status: "resolved" }],
    });
  });

  it("should parse a focus command", () => {
    expect(parseAnnotatorCommand({ type: "hr-annotator/focus", id: "an-1" })).toEqual({
      kind: "focus",
      id: "an-1",
    });
    expect(parseAnnotatorCommand({ type: "hr-annotator/focus", id: "" })).toBeUndefined();
    expect(
      parseAnnotatorCommand({ type: "hr-annotator/focus", id: "an-1", extra: 1 }),
    ).toBeUndefined();
    expect(parseAnnotatorCommand({ type: "hr-annotator/focus", id: 4 })).toBeUndefined();
  });

  it("should drop non-records and unknown types", () => {
    expect(parseAnnotatorCommand(null)).toBeUndefined();
    expect(parseAnnotatorCommand("x")).toBeUndefined();
    expect(parseAnnotatorCommand([ITEM])).toBeUndefined();
    expect(parseAnnotatorCommand({ type: "hr-annotator/selection" })).toBeUndefined();
    expect(parseAnnotatorCommand({})).toBeUndefined();
  });
});
