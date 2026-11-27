// This layer covers the `annotator/run` engine contract: one-shot hello,
// selection-to-anchor messages, highlight registration (pending/resolved),
// focus-to-scroll, caret-to-open, and every missing/poisoned-capture
// degradation branch (no crash, no leaks).

import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import type { AnnotatorEnv } from "../src/annotator/caps.ts";
import type {
  DomElementLike,
  DomMessageLike,
  DomNodeLike,
  DomPointEventLike,
  DomRangeLike,
  DomSelectionLike,
} from "../src/annotator/shapes.ts";
import { runAnnotator } from "../src/annotator/run.ts";

const EL = (value: unknown): DomElementLike => value as DomElementLike;
const ND = (value: unknown): DomNodeLike => value as DomNodeLike;
const RG = (value: unknown): DomRangeLike => value as DomRangeLike;
const PEV = (value: unknown): DomPointEventLike => value as DomPointEventLike;
const MSG = (value: unknown): DomMessageLike => value as DomMessageLike;
const SEL = (value: unknown): DomSelectionLike => value as DomSelectionLike;

interface Captured {
  readonly posted: unknown[];
  readonly docHandlers: Map<string, (event: DomPointEventLike) => void>;
  readonly winHandlers: Map<string, (event: DomMessageLike) => void>;
}

const bodyOf = (html: string): DomElementLike => {
  const win = new Window();
  win.document.body.innerHTML = html;
  return win.document.body as unknown as DomElementLike;
};

const PARENT = { marker: "parent" };

const envOf = (over: Partial<AnnotatorEnv> = {}): { env: AnnotatorEnv; seen: Captured } => {
  const seen: Captured = {
    posted: [],
    docHandlers: new Map(),
    winHandlers: new Map(),
  };
  const env: AnnotatorEnv = {
    post: (message) => {
      seen.posted.push(message);
    },
    parentWindow: PARENT,
    onDocument: (type, fn) => {
      seen.docHandlers.set(type, fn);
    },
    onWindow: (type, fn) => {
      seen.winHandlers.set(type, fn);
    },
    getSelection: () => null,
    rangeAt: () => undefined,
    raf: undefined,
    body: bodyOf(`<p>hola</p>`),
    head: bodyOf(`<p>x</p>`),
    createElement: () => EL({ textContent: "", tag: "style" }),
    appendChild: () => undefined,
    caretFromPoint: () => null,
    newRange: undefined,
    setRange: undefined,
    rangeRect: undefined,
    makeHighlight: undefined,
    highlightRegistry: undefined,
    scrollIntoView: () => undefined,
    adoptSheet: undefined,
    math: { max: Math.max, min: Math.min },
    ...over,
  };
  return { env, seen };
};

const selectionOf = (over: Partial<DomSelectionLike> = {}): DomSelectionLike => ({
  rangeCount: 1,
  isCollapsed: false,
  ...over,
});

const rangeOf = (
  node: DomNodeLike,
  start: number,
  end: number,
  endNode: DomNodeLike = node,
): DomRangeLike =>
  RG({
    startContainer: node,
    startOffset: start,
    endContainer: endNode,
    endOffset: end,
  });

const textNode = (body: DomElementLike, selector: string): DomNodeLike =>
  ND(body.querySelector(selector)?.firstChild);

const fireDoc = (seen: Captured, type: string, event?: DomPointEventLike): void => {
  seen.docHandlers.get(type)?.(event ?? PEV({}));
};

const fireMessage = (seen: Captured, source: unknown, data: unknown): void => {
  seen.winHandlers.get("message")?.(MSG({ source, data }));
};

const messages = (seen: Captured): readonly Record<string, unknown>[] =>
  seen.posted.filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null);

const types = (seen: Captured): readonly unknown[] => messages(seen).map((m) => m["type"]);

describe("annotator run · hello and lifecycle", () => {
  it("should post hello exactly once and bind the four listeners", () => {
    const { env, seen } = envOf();
    runAnnotator(env);
    expect(seen.posted).toEqual([{ type: "hr-annotator/hello", version: 1 }]);
    expect([...seen.docHandlers.keys()].sort()).toEqual(["click", "mouseup", "selectionchange"]);
    expect([...seen.winHandlers.keys()]).toEqual(["message"]);
    // Firing again does not repeat hello.
    fireDoc(seen, "mouseup");
    expect(
      seen.posted.filter((m) => (m as { type?: string }).type === "hr-annotator/hello"),
    ).toHaveLength(1);
  });
});

describe("annotator run · selection to anchor", () => {
  const BODY = `<p>hola <b>mundo</b> tail</p>`;

  const selectionEnv = (over: Partial<AnnotatorEnv> = {}) => {
    const body = bodyOf(BODY);
    const target = textNode(body, "b");
    return envOf({
      body,
      getSelection: () => selectionOf(),
      rangeAt: () => rangeOf(target, 0, 5),
      ...over,
    });
  };

  it("should post the anchor message with selector and rect", () => {
    const { env, seen } = selectionEnv({
      rangeRect: () => ({ x: 1, y: 2, width: 3, height: 4 }),
    });
    runAnnotator(env);
    fireDoc(seen, "selectionchange");
    expect(messages(seen)[1]).toEqual({
      type: "hr-annotator/selection",
      version: 1,
      anchor: { exact: "mundo", prefix: "hola ", suffix: " tail", start: 5 },
      selector: "body > p > b",
      rect: { x: 1, y: 2, w: 3, h: 4 },
    });
  });

  it("should coalesce bursts through raf and fire immediately without it", () => {
    const rafQueue: (() => void)[] = [];
    const { env, seen } = selectionEnv({
      raf: (cb) => {
        rafQueue.push(cb);
      },
    });
    runAnnotator(env);
    fireDoc(seen, "selectionchange");
    fireDoc(seen, "mouseup");
    // Two events queue a single raf callback (coalesced).
    expect(rafQueue).toHaveLength(1);
    rafQueue[0]?.();
    expect(types(seen)).toEqual(["hr-annotator/hello", "hr-annotator/selection"]);
  });

  it("should post cleared on empty selections and nothing when unsupported", () => {
    const { env, seen } = selectionEnv({ getSelection: () => null });
    runAnnotator(env);
    fireDoc(seen, "mouseup");
    expect(types(seen)).toEqual(["hr-annotator/hello", "hr-annotator/selection-cleared"]);

    const collapsed = selectionEnv({ getSelection: () => selectionOf({ isCollapsed: true }) });
    runAnnotator(collapsed.env);
    fireDoc(collapsed.seen, "mouseup");
    expect(types(collapsed.seen)).toEqual(["hr-annotator/hello", "hr-annotator/selection-cleared"]);

    const zeroRanges = selectionEnv({ getSelection: () => selectionOf({ rangeCount: 0 }) });
    runAnnotator(zeroRanges.env);
    fireDoc(zeroRanges.seen, "mouseup");
    expect(types(zeroRanges.seen)).toEqual([
      "hr-annotator/hello",
      "hr-annotator/selection-cleared",
    ]);
  });

  it("should stay silent without getSelection, rangeAt or a valid shape", () => {
    const noSel = selectionEnv({ getSelection: undefined });
    runAnnotator(noSel.env);
    fireDoc(noSel.seen, "mouseup");
    expect(types(noSel.seen)).toEqual(["hr-annotator/hello"]);

    const noRange = selectionEnv({ rangeAt: undefined });
    runAnnotator(noRange.env);
    fireDoc(noRange.seen, "mouseup");
    expect(types(noRange.seen)).toEqual(["hr-annotator/hello"]);

    const badShape = selectionEnv({
      getSelection: () => SEL({ rangeCount: "x", isCollapsed: false }),
    });
    runAnnotator(badShape.env);
    fireDoc(badShape.seen, "mouseup");
    expect(types(badShape.seen)).toEqual(["hr-annotator/hello"]);

    const noRangeObj = selectionEnv({ rangeAt: () => undefined });
    runAnnotator(noRangeObj.env);
    fireDoc(noRangeObj.seen, "mouseup");
    expect(types(noRangeObj.seen)).toEqual(["hr-annotator/hello"]);

    const noBody = selectionEnv({ body: null });
    runAnnotator(noBody.env);
    fireDoc(noBody.seen, "mouseup");
    expect(types(noBody.seen)).toEqual(["hr-annotator/hello"]);
  });

  it("should post cleared when the range is outside body or unmappable", () => {
    const detached = ND(new Window().document.createTextNode("x"));
    const outside = selectionEnv({ rangeAt: () => rangeOf(detached, 0, 1) });
    runAnnotator(outside.env);
    fireDoc(outside.seen, "mouseup");
    expect(types(outside.seen)).toEqual(["hr-annotator/hello", "hr-annotator/selection-cleared"]);

    const dom = bodyOf(BODY);
    const script = dom.ownerDocument.createElement("script");
    dom.appendChild(script);
    const scriptText = script.ownerDocument.createTextNode("x");
    script.appendChild(scriptText);
    // End container inside a skipped subtree makes offsetOfPoint undefined, so cleared.
    const badEnd = envOf({
      body: dom,
      getSelection: () => selectionOf(),
      rangeAt: () =>
        RG({
          startContainer: textNode(dom, "b"),
          startOffset: 0,
          endContainer: scriptText,
          endOffset: 1,
        }),
    });
    runAnnotator(badEnd.env);
    fireDoc(badEnd.seen, "mouseup");
    expect(types(badEnd.seen)).toEqual(["hr-annotator/hello", "hr-annotator/selection-cleared"]);
  });

  it("should post selection-too-long over 500 chars", () => {
    const body = bodyOf(`<p>${"x".repeat(600)}</p>`);
    const { env, seen } = envOf({
      body,
      getSelection: () => selectionOf(),
      rangeAt: () => rangeOf(textNode(body, "p"), 0, 550),
    });
    runAnnotator(env);
    fireDoc(seen, "mouseup");
    expect(types(seen)).toEqual(["hr-annotator/hello", "hr-annotator/selection-too-long"]);
  });

  it("should omit selector when the path is over the limit and zero the rect when unusable", () => {
    const depth = 70;
    const body = bodyOf("<div>".repeat(depth) + "x" + "</div>".repeat(depth));
    let deepest = body.querySelector("div");
    while (deepest !== null) {
      const next = deepest.querySelector("div");
      if (next === null) break;
      deepest = next;
    }
    const target = ND(deepest?.firstChild);
    const { env, seen } = envOf({
      body,
      getSelection: () => selectionOf(),
      rangeAt: () => rangeOf(target, 0, 1),
      rangeRect: () => ({ x: NaN, y: 2, width: Infinity, height: 4 }),
    });
    runAnnotator(env);
    fireDoc(seen, "mouseup");
    const msg = messages(seen)[1] as { selector?: string; rect?: { x: number } };
    expect("selector" in msg).toBe(false);
    expect(msg.rect).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it("should bound the anchor context at 64 chars each side", () => {
    const lead = "y".repeat(200);
    const body = bodyOf(`<p>${lead}TARGET${"z".repeat(200)}</p>`);
    const { env, seen } = envOf({
      body,
      getSelection: () => selectionOf(),
      rangeAt: () => rangeOf(textNode(body, "p"), 200, 206),
    });
    runAnnotator(env);
    fireDoc(seen, "mouseup");
    const msg = messages(seen)[1] as {
      anchor: { exact: string; prefix: string; suffix: string; start: number };
    };
    expect(msg.anchor).toEqual({
      exact: "TARGET",
      prefix: "y".repeat(64),
      suffix: "z".repeat(64),
      start: 200,
    });
  });

  it("should treat exactly 500 chars as a selection and 501 as too long", () => {
    const body = bodyOf(`<p>${"x".repeat(600)}</p>`);
    const atLimit = envOf({
      body,
      getSelection: () => selectionOf(),
      rangeAt: () => rangeOf(textNode(body, "p"), 0, 500),
    });
    runAnnotator(atLimit.env);
    fireDoc(atLimit.seen, "mouseup");
    expect(types(atLimit.seen)[1]).toBe("hr-annotator/selection");

    const overLimit = envOf({
      body,
      getSelection: () => selectionOf(),
      rangeAt: () => rangeOf(textNode(body, "p"), 0, 501),
    });
    runAnnotator(overLimit.env);
    fireDoc(overLimit.seen, "mouseup");
    expect(types(overLimit.seen)[1]).toBe("hr-annotator/selection-too-long");
  });

  it("should post cleared when the range START is unmappable", () => {
    const dom = bodyOf(BODY);
    const script = dom.ownerDocument.createElement("script");
    dom.appendChild(script);
    const scriptText = script.ownerDocument.createTextNode("x");
    script.appendChild(scriptText);
    const { env, seen } = envOf({
      body: dom,
      getSelection: () => selectionOf(),
      rangeAt: () =>
        RG({
          startContainer: scriptText,
          startOffset: 0,
          endContainer: textNode(dom, "b"),
          endOffset: 5,
        }),
    });
    runAnnotator(env);
    fireDoc(seen, "mouseup");
    expect(types(seen)).toEqual(["hr-annotator/hello", "hr-annotator/selection-cleared"]);
  });

  it("should re-schedule a fresh emit after the queued one flushes", () => {
    const rafQueue: (() => void)[] = [];
    const { env, seen } = selectionEnv({
      raf: (cb) => {
        rafQueue.push(cb);
      },
    });
    runAnnotator(env);
    fireDoc(seen, "selectionchange");
    rafQueue[0]?.();
    fireDoc(seen, "selectionchange");
    expect(rafQueue).toHaveLength(2);
    rafQueue[1]?.();
    expect(types(seen).filter((type) => type === "hr-annotator/selection")).toHaveLength(2);
  });

  it("should never throw through a poisoned capture", () => {
    const { env, seen } = selectionEnv({
      getSelection: () => {
        throw new Error("poisoned");
      },
    });
    runAnnotator(env);
    expect(() => {
      fireDoc(seen, "mouseup");
    }).not.toThrow();
    expect(types(seen)).toEqual(["hr-annotator/hello"]);
  });
});

describe("annotator run · highlights, focus and open", () => {
  const registryOf = () => {
    const set: { name: string; value: unknown }[] = [];
    const registry = {
      set: (name: string, value: unknown) => {
        set.push({ name, value });
      },
    };
    return { registry, set };
  };

  const highlightEnv = (over: Partial<AnnotatorEnv> = {}) => {
    const { registry, set } = registryOf();
    return {
      registry,
      set,
      ...envOf({
        body: bodyOf(`<p>hola <b>mundo</b> tail</p>`),
        newRange: () => RG({}),
        setRange: (range, start, end) => {
          const fake = range as { startContainer?: DomNodeLike; endContainer?: DomNodeLike };
          fake.startContainer = start.node;
          fake.endContainer = end.node;
        },
        makeHighlight: (ranges) => ({ ranges }),
        highlightRegistry: registry,
        ...over,
      }),
    };
  };

  it("should register pending and resolved highlights and answer focus", () => {
    const scrolled: DomElementLike[] = [];
    const { env, seen, set } = highlightEnv({
      scrollIntoView: (el) => {
        scrolled.push(el);
      },
    });
    runAnnotator(env);
    const items = [
      { id: "p1", start: 5, end: 10, status: "pending" },
      { id: "r1", start: 0, end: 4, status: "resolved" },
    ];
    fireMessage(seen, PARENT, { type: "hr-annotator/highlights", version: 1, items });
    expect(set.map((s) => s.name)).toEqual(["hr-pending", "hr-resolved"]);
    expect((set[0]?.value as { ranges: unknown[] }).ranges).toHaveLength(1);
    expect((set[1]?.value as { ranges: unknown[] }).ranges).toHaveLength(1);

    fireMessage(seen, PARENT, { type: "hr-annotator/focus", id: "p1" });
    expect(scrolled).toHaveLength(1);
    fireMessage(seen, PARENT, { type: "hr-annotator/focus", id: "otro" });
    expect(scrolled).toHaveLength(1);
  });

  it("should ignore focus on an item whose container lost its element", () => {
    const scrolled: DomElementLike[] = [];
    const detached = ND(new Window().document.createTextNode("x"));
    const { env, seen } = highlightEnv({
      setRange: (range) => {
        (range as { startContainer?: DomNodeLike }).startContainer = detached;
      },
      scrollIntoView: (el) => {
        scrolled.push(el);
      },
    });
    runAnnotator(env);
    fireMessage(seen, PARENT, {
      type: "hr-annotator/highlights",
      version: 1,
      items: [{ id: "p1", start: 5, end: 10, status: "pending" }],
    });
    fireMessage(seen, PARENT, { type: "hr-annotator/focus", id: "p1" });
    expect(scrolled).toHaveLength(0);
  });

  it("should skip unmappable items", () => {
    const { env, seen, set } = highlightEnv();
    runAnnotator(env);
    fireMessage(seen, PARENT, {
      type: "hr-annotator/highlights",
      version: 1,
      items: [
        { id: "a", start: 10, end: 5, status: "pending" }, // end less-or-equal start
        { id: "b", start: 0, end: 999, status: "pending" }, // end beyond text length
        { id: "c", start: 5, end: 10, status: "resolved" },
      ],
    });
    expect((set[0]?.value as { ranges: unknown[] }).ranges).toHaveLength(0);
    expect((set[1]?.value as { ranges: unknown[] }).ranges).toHaveLength(1);
  });

  it("should degrade silently when highlight support is missing", () => {
    for (const missing of ["newRange", "setRange", "makeHighlight", "highlightRegistry"] as const) {
      const { env, seen } = highlightEnv({ [missing]: undefined });
      runAnnotator(env);
      expect(() => {
        fireMessage(seen, PARENT, {
          type: "hr-annotator/highlights",
          version: 1,
          items: [{ id: "p1", start: 5, end: 10, status: "pending" }],
        });
      }).not.toThrow();
    }
    const noBody = highlightEnv({ body: null });
    runAnnotator(noBody.env);
    expect(() => {
      fireMessage(noBody.seen, PARENT, {
        type: "hr-annotator/highlights",
        version: 1,
        items: [{ id: "p1", start: 5, end: 10, status: "pending" }],
      });
    }).not.toThrow();
  });

  it("should swallow highlight paint crashes", () => {
    const { env, seen } = highlightEnv({
      newRange: () => {
        throw new Error("poisoned");
      },
    });
    runAnnotator(env);
    expect(() => {
      fireMessage(seen, PARENT, {
        type: "hr-annotator/highlights",
        version: 1,
        items: [{ id: "p1", start: 5, end: 10, status: "pending" }],
      });
    }).not.toThrow();
  });

  it("should ignore focus crashes", () => {
    const { env, seen } = highlightEnv({
      scrollIntoView: () => {
        throw new Error("poisoned");
      },
    });
    runAnnotator(env);
    fireMessage(seen, PARENT, {
      type: "hr-annotator/highlights",
      version: 1,
      items: [{ id: "p1", start: 5, end: 10, status: "pending" }],
    });
    expect(() => {
      fireMessage(seen, PARENT, { type: "hr-annotator/focus", id: "p1" });
    }).not.toThrow();
  });

  it("should drop messages from other sources and malformed payloads", () => {
    const { env, seen, set } = highlightEnv();
    runAnnotator(env);
    fireMessage(seen, { marker: "intruso" }, { type: "hr-annotator/focus", id: "p1" });
    fireMessage(seen, PARENT, { type: "hr-annotator/highlights", version: 2, items: [] });
    fireMessage(seen, PARENT, "garbage");
    expect(set).toHaveLength(0);
    // A highlights command from a non-parent source must not paint either.
    fireMessage(
      seen,
      { marker: "intruso" },
      {
        type: "hr-annotator/highlights",
        version: 1,
        items: [{ id: "p1", start: 5, end: 10, status: "pending" }],
      },
    );
    expect(set).toHaveLength(0);
  });

  it("should re-clear the applied table when highlights reapply", () => {
    const scrolled: DomElementLike[] = [];
    const { env, seen, set } = highlightEnv({
      scrollIntoView: (el) => {
        scrolled.push(el);
      },
    });
    runAnnotator(env);
    const items = [{ id: "p1", start: 5, end: 10, status: "pending" }];
    fireMessage(seen, PARENT, { type: "hr-annotator/highlights", version: 1, items });
    fireMessage(seen, PARENT, { type: "hr-annotator/highlights", version: 1, items: [] });
    // The second pending bucket is empty, and the stale id must not focus.
    expect((set[2]?.value as { ranges: unknown[] }).ranges).toHaveLength(0);
    fireMessage(seen, PARENT, { type: "hr-annotator/focus", id: "p1" });
    expect(scrolled).toHaveLength(0);
  });

  it("should paint an item ending exactly at text length and skip a zero-length one", () => {
    const { env, seen, set } = highlightEnv();
    runAnnotator(env);
    fireMessage(seen, PARENT, {
      type: "hr-annotator/highlights",
      version: 1,
      items: [
        { id: "a", start: 0, end: 15, status: "pending" }, // end === text.length
        { id: "b", start: 5, end: 5, status: "pending" }, // zero-length
      ],
    });
    expect((set[0]?.value as { ranges: unknown[] }).ranges).toHaveLength(1);
  });
});

describe("annotator run · click to open", () => {
  const OPEN_BODY = `<p>hola <b>mundo</b> tail</p>`;

  const openEnv = (over: Partial<AnnotatorEnv> = {}) => {
    const registry = { set: () => undefined };
    return envOf({
      body: bodyOf(OPEN_BODY),
      newRange: () => RG({}),
      setRange: () => undefined,
      makeHighlight: (ranges) => ({ ranges }),
      highlightRegistry: registry,
      caretFromPoint: () => null,
      ...over,
    });
  };

  const withHighlight = (
    seen: Captured,
    item = { id: "p1", start: 5, end: 10, status: "pending" },
  ): void => {
    fireMessage(seen, PARENT, { type: "hr-annotator/highlights", version: 1, items: [item] });
  };

  it("should post open when the caret lands inside a highlight", () => {
    const body = bodyOf(OPEN_BODY);
    const { env, seen } = openEnv({
      body,
      caretFromPoint: () => ({ node: textNode(body, "b"), offset: 2 }),
    });
    runAnnotator(env);
    withHighlight(seen);
    fireDoc(seen, "click", PEV({ clientX: 10, clientY: 20 }));
    expect(messages(seen).at(-1)).toEqual({ type: "hr-annotator/open", id: "p1" });
  });

  it("should open on a caret exactly at the span start and stay silent at the end", () => {
    const body = bodyOf(OPEN_BODY);
    const { env, seen } = openEnv({
      body,
      caretFromPoint: () => ({ node: textNode(body, "b"), offset: 0 }), // offset 5: item start
    });
    runAnnotator(env);
    withHighlight(seen);
    fireDoc(seen, "click", PEV({ clientX: 10, clientY: 20 }));
    expect(messages(seen).at(-1)).toEqual({ type: "hr-annotator/open", id: "p1" });

    const atEnd = openEnv({
      body,
      caretFromPoint: () => ({ node: textNode(body, "b"), offset: 5 }), // offset 10: item end
    });
    runAnnotator(atEnd.env);
    withHighlight(atEnd.seen);
    fireDoc(atEnd.seen, "click", PEV({ clientX: 10, clientY: 20 }));
    expect(types(atEnd.seen)).toEqual(["hr-annotator/hello"]);
  });

  it("should not open on a stale range after highlights reapply empty", () => {
    const body = bodyOf(OPEN_BODY);
    const { env, seen } = openEnv({
      body,
      caretFromPoint: () => ({ node: textNode(body, "b"), offset: 2 }),
    });
    runAnnotator(env);
    withHighlight(seen);
    fireMessage(seen, PARENT, { type: "hr-annotator/highlights", version: 1, items: [] });
    fireDoc(seen, "click", PEV({ clientX: 10, clientY: 20 }));
    expect(types(seen)).toEqual(["hr-annotator/hello"]);
  });

  it("should not open when the click event carries no numeric coordinates", () => {
    const body = bodyOf(OPEN_BODY);
    const { env, seen } = openEnv({
      body,
      caretFromPoint: () => ({ node: textNode(body, "b"), offset: 2 }),
    });
    runAnnotator(env);
    withHighlight(seen);
    fireDoc(seen, "click", PEV({ clientX: "x", clientY: 20 }));
    fireDoc(seen, "click", PEV({ clientX: 10 }));
    fireDoc(seen, "click", PEV({}));
    expect(types(seen)).toEqual(["hr-annotator/hello"]);
  });

  it("should ignore clicks without usable caret or outside highlights", () => {
    const body = bodyOf(OPEN_BODY);
    const noCaret = openEnv({ body, caretFromPoint: undefined });
    runAnnotator(noCaret.env);
    withHighlight(noCaret.seen);
    fireDoc(noCaret.seen, "click", PEV({ clientX: 1, clientY: 1 }));
    expect(types(noCaret.seen)).toEqual(["hr-annotator/hello"]);

    const noHit = openEnv({ body, caretFromPoint: () => null });
    runAnnotator(noHit.env);
    withHighlight(noHit.seen);
    fireDoc(noHit.seen, "click", PEV({ clientX: 1, clientY: 1 }));
    expect(types(noHit.seen)).toEqual(["hr-annotator/hello"]);

    const outside = openEnv({
      body,
      caretFromPoint: () => ({
        node: ND(new Window().document.createTextNode("x")),
        offset: 0,
      }),
    });
    runAnnotator(outside.env);
    withHighlight(outside.seen);
    fireDoc(outside.seen, "click", PEV({ clientX: 1, clientY: 1 }));
    expect(types(outside.seen)).toEqual(["hr-annotator/hello"]);

    const unmappable = openEnv({
      body,
      caretFromPoint: () => {
        const script = body.ownerDocument.createElement("script");
        body.appendChild(script);
        const t = script.ownerDocument.createTextNode("x");
        script.appendChild(t);
        return { node: t, offset: 0 };
      },
    });
    runAnnotator(unmappable.env);
    withHighlight(unmappable.seen);
    fireDoc(unmappable.seen, "click", PEV({ clientX: 1, clientY: 1 }));
    expect(types(unmappable.seen)).toEqual(["hr-annotator/hello"]);

    const offRange = openEnv({
      body,
      caretFromPoint: () => ({ node: textNode(body, "p"), offset: 0 }),
    });
    runAnnotator(offRange.env);
    withHighlight(offRange.seen);
    fireDoc(offRange.seen, "click", PEV({ clientX: 1, clientY: 1 }));
    expect(types(offRange.seen)).toEqual(["hr-annotator/hello"]);
  });

  it("should ignore clicks without coordinates and swallow caret crashes", () => {
    const body = bodyOf(OPEN_BODY);
    const { env, seen } = openEnv({
      body,
      caretFromPoint: () => {
        throw new Error("poisoned");
      },
    });
    runAnnotator(env);
    withHighlight(seen);
    fireDoc(seen, "click", PEV({}));
    fireDoc(seen, "click", PEV({ clientX: "x", clientY: 1 }));
    fireDoc(seen, "click", PEV({ clientX: 1, clientY: "y" }));
    expect(types(seen)).toEqual(["hr-annotator/hello"]);
    expect(() => {
      fireDoc(seen, "click", PEV({ clientX: 1, clientY: 1 }));
    }).not.toThrow();
  });
});

describe("annotator run · installStyles", () => {
  it("should use adoptedStyleSheets when available", () => {
    const adopted: string[] = [];
    const appended: string[] = [];
    const { env } = envOf({
      adoptSheet: (css) => {
        adopted.push(css);
        return true;
      },
      appendChild: () => {
        appended.push("x");
      },
    });
    runAnnotator(env);
    expect(adopted).toHaveLength(1);
    expect(appended).toHaveLength(0);
  });

  it("should fall back to a <style> element, then to nothing without head", () => {
    const appended: string[] = [];
    const { env } = envOf({
      adoptSheet: () => false,
      appendChild: () => {
        appended.push("x");
      },
    });
    runAnnotator(env);
    expect(appended).toHaveLength(1);

    // No adoptedStyleSheets at all: the same <style> fallback must run.
    const created: string[] = [];
    const appendedToo: string[] = [];
    const noAdopt = envOf({
      adoptSheet: undefined,
      createElement: (tag) => {
        created.push(tag);
        return EL({ textContent: "" });
      },
      appendChild: () => {
        appendedToo.push("x");
      },
    });
    runAnnotator(noAdopt.env);
    expect(created).toEqual(["style"]);
    expect(appendedToo).toHaveLength(1);

    // Without a head the fallback stays silent.
    const appendedThree: string[] = [];
    const noHead = envOf({
      adoptSheet: undefined,
      head: null,
      appendChild: () => {
        appendedThree.push("x");
      },
    });
    runAnnotator(noHead.env);
    expect(appendedThree).toHaveLength(0);

    const broken = envOf({
      adoptSheet: () => {
        throw new Error("poisoned");
      },
    });
    runAnnotator(broken.env);
  });
});
