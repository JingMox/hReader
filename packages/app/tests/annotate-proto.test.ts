// This layer covers the pure `annotate-proto` contract — strict validation of
// frame→reader messages (shape, key sets, limits), lenient sidecar-list reads,
// and the popover placement arithmetic (below→above flip and viewport clamping).

import { describe, expect, it } from "vitest";

import {
  ANCHOR_LIMITS,
  isAnchor,
  NOTE_LIMIT,
  parseFrameMessage,
  placementOf,
  POPOVER_METRICS,
  sidecarListOf,
} from "../src/annotate-proto.ts";

const ANCHOR = { exact: "texto", prefix: "pre", suffix: "post", start: 4 };
const RECT = { x: 10, y: 20, w: 30, h: 8 };

describe("annotate-proto · isAnchor", () => {
  it("should accept a well-formed anchor", () => {
    expect(isAnchor(ANCHOR)).toBe(true);
    expect(isAnchor({ exact: "", prefix: "", suffix: "", start: 0 })).toBe(true);
  });

  it("should reject non-records, extra keys and out-of-bounds fields", () => {
    expect(isAnchor(null)).toBe(false);
    expect(isAnchor("x")).toBe(false);
    expect(isAnchor([ANCHOR])).toBe(false);
    expect(isAnchor({ ...ANCHOR, extra: 1 })).toBe(false);
    expect(isAnchor({ ...ANCHOR, exact: "x".repeat(ANCHOR_LIMITS.exact + 1) })).toBe(false);
    expect(isAnchor({ ...ANCHOR, prefix: "x".repeat(ANCHOR_LIMITS.prefix + 1) })).toBe(false);
    expect(isAnchor({ ...ANCHOR, suffix: "x".repeat(ANCHOR_LIMITS.suffix + 1) })).toBe(false);
    expect(isAnchor({ ...ANCHOR, exact: 4 })).toBe(false);
    expect(isAnchor({ ...ANCHOR, start: -1 })).toBe(false);
    expect(isAnchor({ ...ANCHOR, start: 1.5 })).toBe(false);
    expect(isAnchor({ ...ANCHOR, start: "4" })).toBe(false);
  });
});

describe("annotate-proto · parseFrameMessage", () => {
  it("should parse a hello message", () => {
    expect(parseFrameMessage({ type: "hr-annotator/hello", version: 1 })).toEqual({
      kind: "hello",
    });
    expect(parseFrameMessage({ type: "hr-annotator/hello", version: 2 })).toBeUndefined();
    expect(parseFrameMessage({ type: "hr-annotator/hello", version: 1, extra: 1 })).toBeUndefined();
  });

  it("should parse a selection message with and without selector", () => {
    const base = { type: "hr-annotator/selection", version: 1, anchor: ANCHOR, rect: RECT };
    expect(parseFrameMessage({ ...base, selector: "body > p" })).toEqual({
      kind: "selection",
      anchor: ANCHOR,
      selector: "body > p",
      rect: RECT,
    });
    expect(parseFrameMessage(base)).toEqual({
      kind: "selection",
      anchor: ANCHOR,
      selector: undefined,
      rect: RECT,
    });
  });

  it("should drop malformed selection messages", () => {
    const base = { type: "hr-annotator/selection", version: 1, anchor: ANCHOR, rect: RECT };
    expect(parseFrameMessage({ ...base, version: 2 })).toBeUndefined();
    expect(parseFrameMessage({ ...base, extra: 1 })).toBeUndefined();
    expect(parseFrameMessage({ ...base, anchor: { ...ANCHOR, extra: 1 } })).toBeUndefined();
    expect(parseFrameMessage({ ...base, anchor: "x" })).toBeUndefined();
    expect(parseFrameMessage({ ...base, selector: 42 })).toBeUndefined();
    expect(parseFrameMessage({ ...base, selector: "x".repeat(1025) })).toBeUndefined();
    expect(parseFrameMessage({ ...base, rect: { ...RECT, extra: 1 } })).toBeUndefined();
    expect(parseFrameMessage({ ...base, rect: { ...RECT, x: "a" } })).toBeUndefined();
    expect(parseFrameMessage({ ...base, rect: { ...RECT, x: Infinity } })).toBeUndefined();
    expect(parseFrameMessage({ ...base, rect: { ...RECT, w: 2e8 } })).toBeUndefined();
    expect(parseFrameMessage({ ...base, rect: "rect" })).toBeUndefined();
  });

  it("should parse cleared, too-long and open messages", () => {
    expect(parseFrameMessage({ type: "hr-annotator/selection-cleared" })).toEqual({
      kind: "cleared",
    });
    expect(parseFrameMessage({ type: "hr-annotator/selection-cleared", extra: 1 })).toBeUndefined();
    expect(parseFrameMessage({ type: "hr-annotator/selection-too-long" })).toEqual({
      kind: "tooLong",
    });
    expect(
      parseFrameMessage({ type: "hr-annotator/selection-too-long", extra: 1 }),
    ).toBeUndefined();
    expect(parseFrameMessage({ type: "hr-annotator/open", id: "an-1" })).toEqual({
      kind: "open",
      id: "an-1",
    });
    expect(parseFrameMessage({ type: "hr-annotator/open", id: "" })).toBeUndefined();
    expect(parseFrameMessage({ type: "hr-annotator/open", id: "x".repeat(257) })).toBeUndefined();
    expect(parseFrameMessage({ type: "hr-annotator/open", id: "an-1", extra: 1 })).toBeUndefined();
  });

  it("should drop non-records and unknown types", () => {
    expect(parseFrameMessage(null)).toBeUndefined();
    expect(parseFrameMessage("hello")).toBeUndefined();
    expect(parseFrameMessage([{ type: "hr-annotator/hello", version: 1 }])).toBeUndefined();
    expect(parseFrameMessage({ type: "hr-annotator/other" })).toBeUndefined();
    expect(parseFrameMessage({})).toBeUndefined();
  });
});

describe("annotate-proto · sidecarListOf", () => {
  const entry = {
    id: "an-1",
    status: "pending",
    note: "nota",
    relocation: { ok: true, start: 3, end: 9, via: "anchor" },
  };

  it("should map only well-formed entries", () => {
    const list = sidecarListOf({
      annotations: [
        entry,
        { ...entry, id: "an-2", status: "resolved", relocation: { ok: false, reason: "x" } },
        { ...entry, id: "" },
        { ...entry, id: "x".repeat(257) },
        { ...entry, id: "bad", status: "otro" },
        { ...entry, id: "bad2", note: "x".repeat(NOTE_LIMIT + 1) },
        { ...entry, id: "bad3", relocation: "x" },
        { ...entry, id: "bad4", relocation: { ok: "yes" } },
        { ...entry, id: "bad5", relocation: { ok: true, start: -1, end: 2 } },
      ],
    });
    expect(list).toEqual([
      { id: "an-1", status: "pending", note: "nota", relocation: { ok: true, start: 3, end: 9 } },
      {
        id: "an-2",
        status: "resolved",
        note: "nota",
        relocation: { ok: false, start: 0, end: 0 },
      },
    ]);
  });

  it("should return empty for malformed payloads", () => {
    expect(sidecarListOf(null)).toEqual([]);
    expect(sidecarListOf({})).toEqual([]);
    expect(sidecarListOf({ annotations: "x" })).toEqual([]);
    expect(sidecarListOf({ annotations: [null, 4, "x"] })).toEqual([]);
  });
});

describe("annotate-proto · placementOf", () => {
  const view = { width: 1024, height: 768 };
  const frame = { x: 300, y: 100 };
  const { width, height, margin, gap } = POPOVER_METRICS;

  it("should place the popover below the selection when there is room", () => {
    const spot = placementOf(frame, { x: 20, y: 50, w: 40, h: 10 }, view);
    // below = frame.y + rect.y + rect.h + gap = 100 + 50 + 10 + 6.
    expect(spot).toEqual({ x: 320, y: 166 });
  });

  it("should flip above the selection when there is no room below", () => {
    const spot = placementOf(frame, { x: 20, y: 500, w: 40, h: 10 }, view);
    // above = frame.y + 500 - height - gap; below excedería el viewport.
    expect(spot.y).toBe(100 + 500 - height - gap);
  });

  it("should clamp to the bottom when neither below nor above fits", () => {
    const spot = placementOf(frame, { x: 20, y: 700, w: 40, h: 10 }, view);
    expect(spot.y).toBe(view.height - height - margin);
  });

  it("should clamp horizontally to the viewport", () => {
    expect(placementOf(frame, { x: -500, y: 50, w: 40, h: 10 }, view).x).toBe(margin);
    expect(placementOf(frame, { x: 2000, y: 50, w: 40, h: 10 }, view).x).toBe(
      view.width - width - margin,
    );
  });

  it("should clamp vertically to the viewport on tiny screens", () => {
    const tiny = { width: 200, height: 100 };
    const spot = placementOf(frame, { x: 20, y: 50, w: 40, h: 10 }, tiny);
    expect(spot.x).toBe(margin);
    expect(spot.y).toBeGreaterThanOrEqual(margin);
    // above < margin → clamped to margin (below doesn't fit either).
    expect(spot.y).toBe(margin);
  });

  it("should keep gap margin between popover and selection", () => {
    const spot = placementOf(frame, { x: 20, y: 50, w: 40, h: 10 }, view);
    expect(spot.y).toBe(frame.y + 50 + 10 + gap);
  });
});
