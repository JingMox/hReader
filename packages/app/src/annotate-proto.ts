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

/** One reply inside a sidecar annotation thread (panel rendering only — bounded strings). */
export interface SidecarReplyEntry {
  readonly id: string;
  readonly author: string;
  readonly note: string;
  readonly createdAt: string;
}

/**
 * The sidecar entry the reader paints (highlight offsets) and lists (panel cards):
 * id + status + note + anchor text + author/createdAt + lifecycle + replies + relocation.
 * `relocation.ok:false` keeps the server-computed `reason` so the panel can name it.
 */
export interface SidecarEntry {
  readonly id: string;
  readonly status: "pending" | "resolved";
  readonly note: string;
  readonly exact: string;
  readonly author: string;
  readonly createdAt: string;
  readonly resolvedAt?: string;
  readonly resolutionNote?: string;
  readonly replies: readonly SidecarReplyEntry[];
  readonly relocation:
    | { readonly ok: true; readonly start: number; readonly end: number }
    | { readonly ok: false; readonly start: 0; readonly end: 0; readonly reason: string };
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

const REPLY_LIMIT = 100;
const AUTHOR_LIMIT = 64;
const TIME_LIMIT = 64;
const REASON_LIMIT = 200;

const relocationOf = (value: unknown): SidecarEntry["relocation"] | undefined => {
  if (!isRecord(value) || typeof value["ok"] !== "boolean") return undefined;
  if (value["ok"]) {
    return isOffset(value["start"]) && isOffset(value["end"])
      ? { ok: true, start: value["start"], end: value["end"] }
      : undefined;
  }
  return { ok: false, start: 0, end: 0, reason: stringOf(value["reason"], REASON_LIMIT, "") };
};

const isReplyEntry = (value: unknown): value is SidecarReplyEntry =>
  isRecord(value) &&
  isId(value["id"]) &&
  bounded(value["author"], AUTHOR_LIMIT) &&
  bounded(value["note"], NOTE_LIMIT) &&
  bounded(value["createdAt"], TIME_LIMIT);

const repliesOf = (value: unknown): readonly SidecarReplyEntry[] => {
  if (!Array.isArray(value)) return [];
  const out: SidecarReplyEntry[] = [];
  for (const item of value.slice(0, REPLY_LIMIT)) {
    if (isReplyEntry(item)) {
      out.push({
        id: item.id,
        author: item.author,
        note: item.note,
        createdAt: item.createdAt,
      });
    }
  }
  return out;
};

const exactOf = (value: unknown): string => {
  if (!isRecord(value)) return "";
  const exact = value["exact"];
  return typeof exact === "string" && exact.length <= ANCHOR_LIMITS.exact ? exact : "";
};

const stringOf = (value: unknown, limit: number, fallback: string): string =>
  typeof value === "string" && value.length <= limit ? value : fallback;

const optionalOf = (value: unknown, limit: number): string | undefined =>
  typeof value === "string" && value.length <= limit ? value : undefined;

/** Tolerant list read: drops malformed entries instead of failing the whole list. */
export const sidecarListOf = (data: unknown): readonly SidecarEntry[] => {
  if (!isRecord(data) || !Array.isArray(data["annotations"])) return [];
  const out: SidecarEntry[] = [];
  for (const item of data["annotations"]) {
    if (!isRecord(item)) continue;
    const id = item["id"];
    const status = item["status"];
    const note = item["note"];
    if (!isId(id)) continue;
    if (status !== "pending" && status !== "resolved") continue;
    if (typeof note !== "string" || note.length > NOTE_LIMIT) continue;
    const relocation = relocationOf(item["relocation"]);
    if (relocation === undefined) continue;
    const resolvedAt = optionalOf(item["resolvedAt"], TIME_LIMIT);
    const resolutionNote = optionalOf(item["resolutionNote"], NOTE_LIMIT);
    out.push({
      id,
      status,
      note,
      exact: exactOf(item["anchor"]),
      author: stringOf(item["author"], AUTHOR_LIMIT, "user"),
      createdAt: stringOf(item["createdAt"], TIME_LIMIT, ""),
      ...(resolvedAt === undefined ? {} : { resolvedAt }),
      ...(resolutionNote === undefined ? {} : { resolutionNote }),
      replies: repliesOf(item["replies"]),
      relocation,
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
