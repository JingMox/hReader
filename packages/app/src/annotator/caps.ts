// Environment capture: every function and object reference the annotator touches
// is bound once at script start into a structural env. `Reflect.get` reads the
// current property value (the real builtin if the page has not poisoned it yet)
// and each call site invokes it via `.call` with the right receiver — a page
// that replaces the prototype/global later cannot hijack the captured function.
// A page script that runs BEFORE this defer script can still pre-poison globals:
// captures are best-effort, callers validate shapes and wrap work in try/catch.

import type {
  DomCaretLike,
  DomElementLike,
  DomMessageLike,
  DomNodeLike,
  DomPointEventLike,
  DomRangeLike,
  DomRectLike,
  DomSelectionLike,
  DomSheetLike,
} from "./shapes.ts";

export interface EnvRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface AnnotatorEnv {
  /** postMessage bound to the real parent window; targetOrigin is always "*". */
  readonly post: (message: unknown) => void;
  /** Identity of the parent window for `event.source` checks. */
  readonly parentWindow: unknown;
  readonly onDocument: (type: string, fn: (event: DomPointEventLike) => void) => void;
  readonly onWindow: (type: string, fn: (event: DomMessageLike) => void) => void;
  /** May be undefined when the page pre-poisoned window.getSelection. */
  readonly getSelection: (() => DomSelectionLike | null) | undefined;
  readonly rangeAt:
    ((selection: DomSelectionLike, index: number) => DomRangeLike | undefined) | undefined;
  readonly raf: ((cb: () => void) => void) | undefined;
  readonly body: DomElementLike | null;
  readonly head: DomElementLike | null;
  readonly createElement: (tag: string) => DomElementLike;
  readonly appendChild: (element: DomElementLike, child: DomNodeLike) => void;
  readonly caretFromPoint: ((x: number, y: number) => DomCaretLike | null) | undefined;
  /** undefined Range ctor → highlight paths degrade. */
  readonly newRange: (() => DomRangeLike) | undefined;
  readonly setRange:
    ((range: DomRangeLike, start: DomCaretLike, end: DomCaretLike) => void) | undefined;
  readonly rangeRect: ((range: DomRangeLike) => EnvRect) | undefined;
  readonly makeHighlight: ((ranges: readonly DomRangeLike[]) => unknown) | undefined;
  readonly highlightRegistry: { readonly set: (name: string, value: unknown) => void } | undefined;
  readonly scrollIntoView: (element: DomElementLike) => void;
  /** adoptedStyleSheets install path; false → caller falls back to a <style> element. */
  readonly adoptSheet: ((css: string) => boolean) | undefined;
  readonly math: {
    readonly max: (...values: number[]) => number;
    readonly min: (...values: number[]) => number;
  };
}

/** `Reflect.get` + `.call` typing helper: reads a method value without a bare reference. */
const get = (target: unknown, key: string): unknown =>
  target !== null && (typeof target === "object" || typeof target === "function")
    ? Reflect.get(target, key)
    : undefined;

/** Only real functions survive capture — a poisoned non-function is "absent". */
const fnOf = (value: unknown): unknown => (typeof value === "function" ? value : undefined);

const rectOf = (rect: DomRectLike): EnvRect => {
  return {
    x: typeof rect.x === "number" ? rect.x : (rect.left ?? 0),
    y: typeof rect.y === "number" ? rect.y : (rect.top ?? 0),
    width: typeof rect.width === "number" ? rect.width : 0,
    height: typeof rect.height === "number" ? rect.height : 0,
  };
};

const caretOf = (doc: unknown): ((x: number, y: number) => DomCaretLike | null) | undefined => {
  const fromPoint = (fnOf(get(doc, "caretPositionFromPoint")) ??
    fnOf(get(doc, "caretRangeFromPoint"))) as
    | ((this: unknown, x: number, y: number) => { offsetNode: DomNodeLike; offset: number } | null)
    | undefined;
  if (fromPoint === undefined) return undefined;
  return (x, y) => {
    const hit = fromPoint.call(doc, x, y);
    return hit === null ? null : { node: hit.offsetNode, offset: hit.offset };
  };
};

const adoptSheetOf = (win: unknown, doc: unknown): ((css: string) => boolean) | undefined => {
  const Ctor = fnOf(get(win, "CSSStyleSheet")) as (new () => DomSheetLike) | undefined;
  if (Ctor === undefined || get(doc, "adoptedStyleSheets") === undefined) return undefined;
  return (css) => {
    const sheet = new Ctor();
    sheet.replaceSync(css);
    const current = get(doc, "adoptedStyleSheets") as readonly DomSheetLike[];
    // The support check above guarantees doc is an object carrying the property.
    Reflect.set(doc as object, "adoptedStyleSheets", [...current, sheet]);
    return true;
  };
};

/** `win.<ctor>.prototype` — the prototype is read only when the ctor is a function. */
const protoOf = (ctor: unknown): unknown =>
  typeof ctor === "function" ? (ctor as { prototype?: unknown }).prototype : undefined;

/**
 * Capture the environment. Anything already replaced by the page (getSelection,
 * CSS, CSSStyleSheet, Range, …) is captured as-is — the engine treats missing or
 * misbehaving captures as "unsupported" and degrades instead of crashing.
 */
export const captureEnv = (win: unknown): AnnotatorEnv => {
  const doc = get(win, "document");
  const parent = get(win, "parent");
  const postMessage = fnOf(get(parent, "postMessage")) as
    ((this: unknown, message: unknown, origin: string) => void) | undefined;
  const addToDoc = fnOf(get(doc, "addEventListener")) as
    ((this: unknown, type: string, fn: unknown) => void) | undefined;
  const addToWin = fnOf(get(win, "addEventListener")) as
    ((this: unknown, type: string, fn: unknown) => void) | undefined;
  const getSelection = fnOf(get(win, "getSelection")) as
    ((this: unknown) => DomSelectionLike | null) | undefined;
  const raf = fnOf(get(win, "requestAnimationFrame")) as
    ((this: unknown, cb: () => void) => void) | undefined;
  const createElement = fnOf(get(doc, "createElement")) as
    ((this: unknown, tag: string) => DomElementLike) | undefined;
  const appendChild = fnOf(get(protoOf(get(win, "Node")), "appendChild")) as
    ((this: DomElementLike, child: DomNodeLike) => void) | undefined;
  const scrollIntoView = fnOf(get(protoOf(get(win, "Element")), "scrollIntoView")) as
    ((this: DomElementLike) => void) | undefined;
  const rangeProto = protoOf(get(win, "Range"));
  const setStart = fnOf(get(rangeProto, "setStart")) as
    ((this: DomRangeLike, node: DomNodeLike, offset: number) => void) | undefined;
  const setEnd = fnOf(get(rangeProto, "setEnd")) as
    ((this: DomRangeLike, node: DomNodeLike, offset: number) => void) | undefined;
  const boundRect = fnOf(get(rangeProto, "getBoundingClientRect")) as
    ((this: DomRangeLike) => DomRectLike) | undefined;
  const getRangeAt = fnOf(get(protoOf(get(win, "Selection")), "getRangeAt")) as
    ((this: DomSelectionLike, index: number) => DomRangeLike) | undefined;
  const RangeCtor = fnOf(get(win, "Range")) as (new () => DomRangeLike) | undefined;
  const HighlightCtor = fnOf(get(win, "Highlight")) as
    (new (...ranges: readonly DomRangeLike[]) => unknown) | undefined;
  const highlights = get(get(win, "CSS"), "highlights");
  const registry =
    fnOf(get(highlights, "set")) === undefined
      ? undefined
      : (highlights as { readonly set: (name: string, value: unknown) => void });

  return {
    post: (message) => {
      try {
        postMessage?.call(parent, message, "*");
      } catch {
        // A pre-poisoned postMessage must degrade silently — hello included.
      }
    },
    parentWindow: parent,
    onDocument: (type, fn) => {
      addToDoc?.call(doc, type, fn);
    },
    onWindow: (type, fn) => {
      addToWin?.call(win, type, fn);
    },
    getSelection: getSelection === undefined ? undefined : () => getSelection.call(win),
    rangeAt:
      getRangeAt === undefined
        ? undefined
        : (selection, index) => {
            try {
              return getRangeAt.call(selection, index);
            } catch {
              return undefined;
            }
          },
    raf:
      raf === undefined
        ? undefined
        : (cb) => {
            raf.call(win, cb);
          },
    body: get(doc, "body") as DomElementLike | null,
    head: get(doc, "head") as DomElementLike | null,
    createElement: (tag) => {
      // A poisoned createElement must fail loudly into the caller's try/catch —
      // silently returning a non-element would corrupt the style fallback path.
      if (createElement === undefined) throw new Error("createElement unavailable");
      return createElement.call(doc, tag);
    },
    appendChild: (element, child) => {
      appendChild?.call(element, child);
    },
    caretFromPoint: caretOf(doc),
    newRange: RangeCtor === undefined ? undefined : () => new RangeCtor(),
    setRange:
      setStart === undefined || setEnd === undefined
        ? undefined
        : (range, start, end) => {
            setStart.call(range, start.node, start.offset);
            setEnd.call(range, end.node, end.offset);
          },
    rangeRect: boundRect === undefined ? undefined : (range) => rectOf(boundRect.call(range)),
    makeHighlight:
      HighlightCtor === undefined ? undefined : (ranges) => new HighlightCtor(...ranges),
    highlightRegistry:
      registry === undefined
        ? undefined
        : {
            set: (name, value) => {
              registry.set.call(registry, name, value);
            },
          },
    scrollIntoView: (element) => {
      try {
        scrollIntoView?.call(element);
      } catch {
        // scrollIntoView is optional behaviour; a hostile page may have neutered it.
      }
    },
    adoptSheet: adoptSheetOf(win, doc),
    math: { max: Math.max, min: Math.min },
  };
};
