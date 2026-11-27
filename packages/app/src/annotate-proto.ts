// Frame-message shapes for annotate mode, mirrored from the annotator's outbound
// contract, plus the reader-side bounds from core's sidecar model (the app package
// cannot import @hreader/core). Validation is hand-rolled and strict: exact key
// sets, bounded strings, bounded arrays, no coercion — anything else is dropped.

export const ANCHOR_LIMITS = { exact: 500, prefix: 64, suffix: 64 } as const;
export const NOTE_LIMIT = 2000 as const;
const ID_LIMIT = 256;
const SELECTOR_LIMIT = 1024;
const RECT_BOUND = 1e8;

/** The wire shape mirrored from core's TextAnchor (dom.ts declares the twin). */
export interface WireAnchor {
  readonly exact: string;
  readonly prefix: string;
  readonly suffix: string;
  readonly start: number;
}

interface WireRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

type FrameMessage =
  | { readonly kind: "hello" }
  | {
      readonly kind: "selection";
      readonly anchor: WireAnchor;
      readonly selector: string | undefined;
      readonly rect: WireRect;
    }
  | { readonly kind: "cleared" }
  | { readonly kind: "tooLong" }
  | { readonly kind: "open"; readonly id: string };

/** The slice of a sidecar entry the reader paints: id + status + note + relocation. */
export interface SidecarPaint {
  readonly id: string;
  readonly status: "pending" | "resolved";
  readonly note: string;
  readonly relocation: { readonly ok: boolean; readonly start: number; readonly end: number };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (record: Record<string, unknown>, keys: readonly string[]): boolean => {
  for (const key of Object.keys(record)) {
    let ok = false;
    for (const allowed of keys) {
      if (key === allowed) {
        ok = true;
        break;
      }
    }
    if (!ok) return false;
  }
  return true;
};

const bounded = (value: unknown, limit: number): value is string =>
  typeof value === "string" && value.length <= limit;

const isOffset = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= ID_LIMIT;

export const isAnchor = (value: unknown): value is WireAnchor =>
  isRecord(value) &&
  hasOnlyKeys(value, ["exact", "prefix", "suffix", "start"]) &&
  bounded(value["exact"], ANCHOR_LIMITS.exact) &&
  bounded(value["prefix"], ANCHOR_LIMITS.prefix) &&
  bounded(value["suffix"], ANCHOR_LIMITS.suffix) &&
  isOffset(value["start"]);

const isFiniteBounded = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= RECT_BOUND;

const isRect = (value: unknown): value is WireRect =>
  isRecord(value) &&
  hasOnlyKeys(value, ["x", "y", "w", "h"]) &&
  isFiniteBounded(value["x"]) &&
  isFiniteBounded(value["y"]) &&
  isFiniteBounded(value["w"]) &&
  isFiniteBounded(value["h"]);

const isSelector = (value: unknown): value is string =>
  typeof value === "string" && value.length <= SELECTOR_LIMIT;

/** Strict frame→reader validation; undefined = drop silently (no network, no UI). */
export const parseFrameMessage = (data: unknown): FrameMessage | undefined => {
  if (!isRecord(data)) return undefined;
  const type = data["type"];
  if (type === "hr-annotator/hello") {
    return hasOnlyKeys(data, ["type", "version"]) && data["version"] === 1
      ? { kind: "hello" }
      : undefined;
  }
  if (type === "hr-annotator/selection") {
    if (data["version"] !== 1) return undefined;
    if (!hasOnlyKeys(data, ["type", "version", "anchor", "selector", "rect"])) return undefined;
    if (!isAnchor(data["anchor"])) return undefined;
    if ("selector" in data && !isSelector(data["selector"])) return undefined;
    if (!isRect(data["rect"])) return undefined;
    return {
      kind: "selection",
      anchor: data["anchor"],
      selector: "selector" in data ? (data["selector"] as string) : undefined,
      rect: data["rect"],
    };
  }
  if (type === "hr-annotator/selection-cleared") {
    return hasOnlyKeys(data, ["type"]) ? { kind: "cleared" } : undefined;
  }
  if (type === "hr-annotator/selection-too-long") {
    return hasOnlyKeys(data, ["type"]) ? { kind: "tooLong" } : undefined;
  }
  if (type === "hr-annotator/open") {
    return hasOnlyKeys(data, ["type", "id"]) && isId(data["id"])
      ? { kind: "open", id: data["id"] }
      : undefined;
  }
  return undefined;
};

const isPaintEntry = (value: unknown): value is SidecarPaint => {
  if (!isRecord(value)) return false;
  if (!isId(value["id"])) return false;
  if (value["status"] !== "pending" && value["status"] !== "resolved") return false;
  if (typeof value["note"] !== "string" || value["note"].length > NOTE_LIMIT) return false;
  const relocation = value["relocation"];
  if (!isRecord(relocation) || typeof relocation["ok"] !== "boolean") return false;
  if (relocation["ok"]) {
    return isOffset(relocation["start"]) && isOffset(relocation["end"]);
  }
  return true;
};

/** Tolerant list read: drops malformed entries instead of failing the whole list. */
export const sidecarListOf = (data: unknown): readonly SidecarPaint[] => {
  if (!isRecord(data) || !Array.isArray(data["annotations"])) return [];
  const out: SidecarPaint[] = [];
  for (const item of data["annotations"]) {
    if (!isPaintEntry(item)) continue;
    const relocation = item.relocation;
    out.push({
      id: item.id,
      status: item.status,
      note: item.note,
      relocation: relocation.ok
        ? { ok: true, start: relocation.start, end: relocation.end }
        : { ok: false, start: 0, end: 0 },
    });
  }
  return out;
};

interface ViewSize {
  readonly width: number;
  readonly height: number;
}

export const POPOVER_METRICS = { width: 320, height: 200, margin: 8, gap: 6 } as const;

const clamp = (value: number, lo: number, hi: number): number =>
  value < lo ? lo : value > hi ? hi : value;

/**
 * Popover placement in reader-shell coordinates: the iframe's bounding rect plus
 * the in-frame selection rect, clamped to the viewport. Flips above the selection
 * when there is no room below.
 */
export const placementOf = (
  frame: { readonly x: number; readonly y: number },
  rect: WireRect,
  view: ViewSize,
): { readonly x: number; readonly y: number } => {
  const { width, height, margin, gap } = POPOVER_METRICS;
  const maxX = Math.max(margin, view.width - width - margin);
  const maxY = Math.max(margin, view.height - height - margin);
  const x = clamp(frame.x + rect.x, margin, maxX);
  const below = frame.y + rect.y + rect.h + gap;
  const above = frame.y + rect.y - height - gap;
  const y = below + height <= view.height - margin ? below : above;
  return { x, y: clamp(y, margin, maxY) };
};
