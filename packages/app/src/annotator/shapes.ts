// Structural DOM twins for the annotator bundle. The package tsconfig carries no
// DOM lib (root typecheck covers all of src/), so every browser shape the engine
// touches is declared here as a minimal interface. Values arrive as `unknown`
// through `captureEnv` and are cast once at the boundary; inside the engine only
// these shapes exist.

/** Indexed + iterable node list (NodeList / HTMLCollection twins). */
export type DomListLike<T> = ArrayLike<T> & Iterable<T>;

/** Any DOM node — only the members the text model reads. */
export interface DomNodeLike {
  readonly nodeType: number;
  readonly parentNode: DomNodeLike | null;
  readonly parentElement: DomElementLike | null;
  readonly childNodes: DomListLike<DomNodeLike>;
}

/** The document members reachable through an element (tests + text construction). */
export interface DomDocumentLike {
  readonly createElement: (tag: string) => DomElementLike;
  readonly createTextNode: (data: string) => DomNodeLike;
}

/** An element node: nodeType 1 with element-specific members. */
export interface DomElementLike extends DomNodeLike {
  readonly id: string;
  readonly localName: string;
  readonly children: DomListLike<DomElementLike>;
  readonly firstChild: DomNodeLike | null;
  readonly lastChild: DomNodeLike | null;
  readonly ownerDocument: DomDocumentLike;
  readonly querySelector: (selector: string) => DomElementLike | null;
  readonly querySelectorAll: (selector: string) => DomListLike<DomElementLike>;
  readonly appendChild: (node: DomNodeLike) => DomNodeLike;
  textContent: string | null;
}

/** A text node: nodeType 3 carrying character data. */
export interface DomTextLike extends DomNodeLike {
  readonly data: string;
}

/** The Range shape the engine needs: boundary points plus opaque identity. */
export interface DomRangeLike {
  readonly startContainer: DomNodeLike;
  readonly startOffset: number;
  readonly endContainer: DomNodeLike;
  readonly endOffset: number;
}

/** caretPositionFromPoint / caretRangeFromPoint result. */
export interface DomCaretLike {
  readonly node: DomNodeLike;
  readonly offset: number;
}

/** The subset of Selection the engine reads. */
export interface DomSelectionLike {
  readonly rangeCount: number;
  readonly isCollapsed: boolean;
}

/** A raw getBoundingClientRect payload; x/y are preferred, left/top the fallback. */
export interface DomRectLike {
  readonly x?: number;
  readonly y?: number;
  readonly left?: number;
  readonly top?: number;
  readonly width?: number;
  readonly height?: number;
}

/** Mouse/click event coordinates for the open-hit test. */
export interface DomPointEventLike {
  readonly clientX: number;
  readonly clientY: number;
}

/** postMessage event subset: sender identity plus payload. */
export interface DomMessageLike {
  readonly source: unknown;
  readonly data: unknown;
}

/** CSSStyleSheet constructor result: only replaceSync is used. */
export interface DomSheetLike {
  readonly replaceSync: (css: string) => void;
}
