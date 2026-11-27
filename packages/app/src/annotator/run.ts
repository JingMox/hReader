// The annotator engine: selection → anchor message, highlight painting via the CSS
// Custom Highlight API, click → open. Everything flows through the captured env;
// every handler is wrapped so a poisoned capture degrades silently instead of
// throwing through a hostile page's call stack.

import type { AnnotatorEnv } from "./caps.ts";
import { parseAnnotatorCommand, type HighlightItem } from "./proto.ts";
import type { DomRangeLike } from "./shapes.ts";
import {
  domBodyMapOf,
  elementOfPoint,
  insideBody,
  type DomPoint,
  type DomTextMap,
} from "./text-model.ts";

const EXACT_LIMIT = 500;
const CONTEXT_LIMIT = 64;

const HIGHLIGHT_CSS =
  "::highlight(hr-pending){background-color:rgba(255,205,80,.45);color:inherit}" +
  "::highlight(hr-resolved){background-color:rgba(140,190,150,.35);color:inherit}";

const PENDING_NAME = "hr-pending";
const RESOLVED_NAME = "hr-resolved";

interface AppliedItem {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly range: DomRangeLike;
}

interface ParsedRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const finite = (value: number): boolean => Number.isFinite(value);

const rectPayload = (
  rect: ParsedRect | undefined,
): { x: number; y: number; w: number; h: number } => {
  if (
    rect === undefined ||
    !finite(rect.x) ||
    !finite(rect.y) ||
    !finite(rect.width) ||
    !finite(rect.height)
  ) {
    return { x: 0, y: 0, w: 0, h: 0 };
  }
  return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
};

interface SelectionSnapshot {
  readonly anchor: { exact: string; prefix: string; suffix: string; start: number };
  readonly selector: string | undefined;
  readonly rect: ParsedRect | undefined;
  readonly tooLong: boolean;
}

/** Convert the live selection into a text-domain snapshot, or undefined when empty/outside. */
const snapshotOf = (
  env: AnnotatorEnv,
  map: DomTextMap,
): SelectionSnapshot | "empty" | undefined => {
  if (env.getSelection === undefined || env.rangeAt === undefined) return undefined;
  const selection = env.getSelection();
  if (selection === null) return "empty";
  const count = selection.rangeCount;
  const collapsed = selection.isCollapsed;
  if (typeof count !== "number" || typeof collapsed !== "boolean") return undefined;
  if (collapsed || count < 1) return "empty";
  const range = env.rangeAt(selection, 0);
  if (range === undefined || env.body === null) return undefined;
  const { startContainer, startOffset, endContainer, endOffset } = range;
  if (!insideBody(env.body, startContainer) || !insideBody(env.body, endContainer)) {
    return "empty";
  }
  const start = map.offsetOfPoint(startContainer, startOffset);
  const end = map.offsetOfPoint(endContainer, endOffset);
  if (start === undefined || end === undefined || end <= start) return "empty";
  const text = map.text;
  const exact = text.slice(start, end);
  if (exact.length > EXACT_LIMIT)
    return {
      anchor: { exact: "", prefix: "", suffix: "", start },
      selector: undefined,
      rect: undefined,
      tooLong: true,
    };
  const prefix = text.slice(env.math.max(0, start - CONTEXT_LIMIT), start);
  const suffix = text.slice(end, end + CONTEXT_LIMIT);
  let selector: string | undefined;
  const element = elementOfPoint(startContainer);
  if (element !== undefined) selector = map.selectorOf(element);
  const rect = env.rangeRect === undefined ? undefined : env.rangeRect(range);
  return {
    anchor: { exact, prefix, suffix, start },
    selector,
    rect,
    tooLong: false,
  };
};

const emitSelection = (env: AnnotatorEnv): void => {
  try {
    if (env.body === null) return;
    const map = domBodyMapOf(env.body);
    const snapshot = snapshotOf(env, map);
    if (snapshot === "empty") {
      env.post({ type: "hr-annotator/selection-cleared" });
      return;
    }
    if (snapshot === undefined) return;
    if (snapshot.tooLong) {
      env.post({ type: "hr-annotator/selection-too-long" });
      return;
    }
    const message: Record<string, unknown> = {
      type: "hr-annotator/selection",
      version: 1,
      anchor: snapshot.anchor,
      rect: rectPayload(snapshot.rect),
    };
    if (snapshot.selector !== undefined) message["selector"] = snapshot.selector;
    env.post(message);
  } catch {
    // A poisoned capture must degrade silently — never throw through the page's stack.
  }
};

const installStyles = (env: AnnotatorEnv): void => {
  try {
    if (env.adoptSheet?.(HIGHLIGHT_CSS)) return;
    if (env.head === null) return;
    const style = env.createElement("style");
    style.textContent = HIGHLIGHT_CSS;
    env.appendChild(env.head, style);
  } catch {
    // Stylesheet install is best-effort; highlights still register without it.
  }
};

interface AppliedTable {
  readonly byId: Map<string, AppliedItem>;
  /** Iterated view for openAt: `Map.values()` is a clobberable prototype method. */
  readonly list: AppliedItem[];
}

const clearApplied = (applied: AppliedTable): void => {
  applied.byId.clear();
  applied.list.length = 0;
};

/** Rebuild the highlight registry entries and the id→range table for click/focus. */
const applyHighlights = (
  env: AnnotatorEnv,
  items: readonly HighlightItem[],
  applied: AppliedTable,
): void => {
  try {
    clearApplied(applied);
    if (
      env.body === null ||
      env.newRange === undefined ||
      env.setRange === undefined ||
      env.makeHighlight === undefined ||
      env.highlightRegistry === undefined
    ) {
      return;
    }
    const map = domBodyMapOf(env.body);
    const pending: DomRangeLike[] = [];
    const resolved: DomRangeLike[] = [];
    for (const item of items) {
      if (item.end <= item.start || item.end > map.text.length) continue;
      // In-bounds offsets always map (start < end ≤ text.length).
      const start = map.pointAt(item.start) as unknown as DomPoint;
      const end = map.pointAt(item.end) as unknown as DomPoint;
      const range = env.newRange();
      env.setRange(range, start, end);
      const entry = { id: item.id, start: item.start, end: item.end, range };
      applied.byId.set(item.id, entry);
      applied.list[applied.list.length] = entry;
      if (item.status === "pending") pending[pending.length] = range;
      else resolved[resolved.length] = range;
    }
    env.highlightRegistry.set(PENDING_NAME, env.makeHighlight(pending));
    env.highlightRegistry.set(RESOLVED_NAME, env.makeHighlight(resolved));
  } catch {
    // Painting is best-effort; selection still works without it.
  }
};

const focusItem = (env: AnnotatorEnv, applied: AppliedTable, id: string): void => {
  try {
    const item = applied.byId.get(id);
    if (item === undefined) return;
    const element = elementOfPoint(item.range.startContainer);
    if (element === undefined) return;
    env.scrollIntoView(element);
  } catch {
    // Focus is best-effort.
  }
};

/** Hit-test a caret position against the applied highlight spans (offsets, not ranges). */
const openAt = (env: AnnotatorEnv, applied: AppliedTable, x: number, y: number): void => {
  try {
    if (env.caretFromPoint === undefined || env.body === null) return;
    const hit = env.caretFromPoint(x, y);
    if (hit === null || !insideBody(env.body, hit.node)) return;
    const map = domBodyMapOf(env.body);
    const offset = map.offsetOfPoint(hit.node, hit.offset);
    if (offset === undefined) return;
    for (const item of applied.list) {
      if (offset >= item.start && offset < item.end) {
        env.post({ type: "hr-annotator/open", id: item.id });
        return;
      }
    }
  } catch {
    // Clicks are best-effort.
  }
};

export const runAnnotator = (env: AnnotatorEnv): void => {
  const applied: AppliedTable = { byId: new Map(), list: [] };
  installStyles(env);

  let scheduled = false;
  const queueSelection = (): void => {
    if (scheduled) return;
    scheduled = true;
    const flush = (): void => {
      scheduled = false;
      emitSelection(env);
    };
    if (env.raf === undefined) flush();
    else env.raf(flush);
  };

  env.onDocument("selectionchange", () => {
    queueSelection();
  });
  env.onDocument("mouseup", () => {
    queueSelection();
  });
  env.onDocument("click", (event) => {
    if (typeof event.clientX !== "number" || typeof event.clientY !== "number") return;
    openAt(env, applied, event.clientX, event.clientY);
  });
  env.onWindow("message", (event) => {
    if (event.source !== env.parentWindow) return;
    const command = parseAnnotatorCommand(event.data);
    if (command === undefined) return;
    if (command.kind === "highlights") applyHighlights(env, command.items, applied);
    else focusItem(env, applied, command.id);
  });

  env.post({ type: "hr-annotator/hello", version: 1 });
};
