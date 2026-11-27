// This layer covers `annotator/caps` (environment capture) and the `index`
// bootstrap: every capture binds the right receiver via Reflect.get/.call,
// every missing or pre-poisoned global degrades to undefined, and the
// module entry stays inert outside a real window context.

import { describe, expect, it, vi } from "vitest";

import { captureEnv } from "../src/annotator/caps.ts";
import type { DomElementLike, DomNodeLike, DomRangeLike } from "../src/annotator/shapes.ts";

const EL = (value: unknown): DomElementLike => value as DomElementLike;
const ND = (value: unknown): DomNodeLike => value as DomNodeLike;
const RG = (value: unknown): DomRangeLike => value as DomRangeLike;

type FakeWin = Record<string, unknown> & {
  document: Record<string, unknown>;
  parent: Record<string, unknown>;
};

const calls: string[] = [];

const elementProto = {
  scrollIntoView: () => {
    calls.push("scrollIntoView");
  },
};
const nodeProto = {
  appendChild: function (this: unknown, child: unknown) {
    calls.push(`append:${String(child === "x")}`);
    return child;
  },
};

const baseWin = (over: Record<string, unknown> = {}): FakeWin => ({
  document: {
    addEventListener(type: string) {
      calls.push(`doc-on:${type}`);
    },
    createElement(tag: string) {
      calls.push(`create:${tag}`);
      return { tag };
    },
    body: { is: "body" },
    head: { is: "head" },
    adoptedStyleSheets: [{ sheet: 1 }],
    caretPositionFromPoint: (x: number, y: number) => ({
      offsetNode: { n: `${String(x)},${String(y)}` },
      offset: 7,
    }),
  },
  parent: {
    postMessage(message: unknown, origin: string) {
      calls.push(`post:${String((message as { type?: string }).type)}:${origin}`);
    },
  },
  addEventListener(type: string) {
    calls.push(`win-on:${type}`);
  },
  getSelection: () => "sel",
  requestAnimationFrame: (cb: () => void) => {
    calls.push("raf");
    cb();
  },
  Node: function Node() {
    return null;
  },
  Element: function Element() {
    return null;
  },
  Range: function Range() {
    return null;
  },
  Selection: function Selection() {
    return null;
  },
  Highlight: function Highlight(this: unknown, ...ranges: unknown[]) {
    (this as { ranges?: unknown[] }).ranges = ranges;
  },
  CSS: { highlights: { set: () => calls.push("hl-set") } },
  CSSStyleSheet: function CSSStyleSheet(this: {
    replaceSync?: (css: string) => void;
    tag?: string;
  }) {
    this.tag = "sheet";
    this.replaceSync = (css: string) => {
      calls.push(`css:${String(css.length > 0)}`);
    };
  },
  ...over,
});

const winFor = (over: Record<string, unknown> = {}): FakeWin => {
  const win = baseWin(over);
  const setProto = (ctor: unknown, proto: unknown): void => {
    if (typeof ctor === "function") {
      (ctor as { prototype?: unknown }).prototype = proto;
    }
  };
  setProto(win["Node"], nodeProto);
  setProto(win["Element"], elementProto);
  setProto(win["Range"], {
    setStart(_node: unknown, offset: number) {
      calls.push(`setStart:${String(offset)}`);
    },
    setEnd(_node: unknown, offset: number) {
      calls.push(`setEnd:${String(offset)}`);
    },
    getBoundingClientRect() {
      return { left: 11, top: 22, width: 33, height: 44 };
    },
  });
  setProto(win["Selection"], {
    getRangeAt(index: number) {
      calls.push(`rangeAt:${String(index)}`);
      return { r: index };
    },
  });
  return win;
};

describe("annotator caps · happy path", () => {
  it("should bind every capture to its receiver and wrap them structurally", () => {
    calls.length = 0;
    const win = winFor();
    const env = captureEnv(win);

    env.post({ type: "hello" });
    env.onDocument("click", () => undefined);
    env.onWindow("message", () => undefined);
    env.raf?.(() => undefined);
    expect(env.getSelection?.()).toBe("sel");
    expect(env.rangeAt?.({ rangeCount: 1, isCollapsed: false }, 0)).toEqual({ r: 0 });
    env.appendChild(EL({}), ND("x"));
    env.scrollIntoView(EL({}));
    const range = env.newRange?.();
    env.setRange?.(RG(range), { node: ND({}), offset: 3 }, { node: ND({}), offset: 9 });
    expect(env.rangeRect?.(RG(range))).toEqual({ x: 11, y: 22, width: 33, height: 44 });
    const hl = env.makeHighlight?.([RG(range)]);
    expect((hl as { ranges: unknown[] }).ranges).toHaveLength(1);
    env.highlightRegistry?.set("hr-pending", hl);
    const el = env.createElement("style");
    expect(el).toEqual({ tag: "style" });
    expect(env.caretFromPoint?.(4, 5)).toEqual({ node: { n: "4,5" }, offset: 7 });
    expect(env.body).toEqual({ is: "body" });
    expect(env.head).toEqual({ is: "head" });
    expect(env.math.max(1, 5)).toBe(5);
    expect(env.math.min(1, 5)).toBe(1);

    expect(calls).toEqual([
      "post:hello:*",
      "doc-on:click",
      "win-on:message",
      "raf",
      "rangeAt:0",
      "append:true",
      "scrollIntoView",
      "setStart:3",
      "setEnd:9",
      "hl-set",
      "create:style",
    ]);
  });

  it("should adopt a stylesheet preserving existing entries", () => {
    calls.length = 0;
    const win = winFor();
    const doc = win.document as { adoptedStyleSheets: unknown[] };
    const env = captureEnv(win);
    expect(env.adoptSheet?.("::highlight(x){}")).toBe(true);
    expect(doc.adoptedStyleSheets).toHaveLength(2);
    expect((doc.adoptedStyleSheets[1] as { tag?: string }).tag).toBe("sheet");
    expect(calls).toContain("css:true");
  });

  it("should fall back to caretRangeFromPoint when the newer API is absent", () => {
    const win = winFor();
    delete win.document["caretPositionFromPoint"];
    win.document["caretRangeFromPoint"] = () => ({
      offsetNode: { n: "rb" },
      offset: 2,
    });
    const env = captureEnv(win);
    expect(env.caretFromPoint?.(0, 0)).toEqual({ node: { n: "rb" }, offset: 2 });
  });

  it("should map a null caret hit to null and tolerate missing caret APIs", () => {
    const win = winFor();
    win.document["caretPositionFromPoint"] = () => null;
    let env = captureEnv(win);
    expect(env.caretFromPoint?.(0, 0)).toBeNull();

    delete win.document["caretPositionFromPoint"];
    env = captureEnv(win);
    expect(env.caretFromPoint).toBeUndefined();
  });
});

describe("annotator caps · degradation", () => {
  it("should degrade every optional capture when globals are missing", () => {
    calls.length = 0;
    const win = winFor({
      getSelection: undefined,
      requestAnimationFrame: undefined,
      Range: 42,
      Selection: undefined,
      Highlight: undefined,
      CSS: null,
      CSSStyleSheet: undefined,
    });
    delete win.document["caretPositionFromPoint"];
    delete win.document["adoptedStyleSheets"];
    const env = captureEnv(win);

    expect(env.getSelection).toBeUndefined();
    expect(env.rangeAt).toBeUndefined();
    expect(env.raf).toBeUndefined();
    expect(env.newRange).toBeUndefined();
    expect(env.setRange).toBeUndefined();
    expect(env.rangeRect).toBeUndefined();
    expect(env.makeHighlight).toBeUndefined();
    expect(env.highlightRegistry).toBeUndefined();
    expect(env.caretFromPoint).toBeUndefined();
    expect(env.adoptSheet).toBeUndefined();
    // Still safe: optional captures swallow a missing underlying function.
    env.post({ type: "x" });
    env.appendChild(EL({}), ND({}));
    env.scrollIntoView(EL({}));
    expect(env.createElement("b")).toEqual({ tag: "b" });
  });

  it("should treat pre-poisoned shapes as missing, not as calls to make", () => {
    const win = winFor({
      getSelection: "poisoned",
      Range: "poisoned",
      Selection: "poisoned",
      Highlight: "poisoned",
      CSS: { highlights: 7 },
      postMessage: undefined,
    });
    win.parent["postMessage"] = "poisoned";
    win.document["createElement"] = "poisoned";
    const env = captureEnv(win);
    // Non-function poison is filtered at capture: the capture is "absent".
    expect(env.getSelection).toBeUndefined();
    expect(env.newRange).toBeUndefined();
    expect(env.rangeAt).toBeUndefined();
    expect(env.makeHighlight).toBeUndefined();
    expect(env.highlightRegistry).toBeUndefined();
    expect(() => {
      env.post({ type: "x" });
    }).not.toThrow();
    // A doubly-poisoned createElement throws; callers wrap in try/catch (installStyles).
    expect(() => env.createElement("b")).toThrow();
    expect(() => {
      env.scrollIntoView(EL({}));
    }).not.toThrow();
  });

  it("should degrade when the DOM constructors themselves are poisoned", () => {
    const win = winFor({ Node: 42, Element: "poisoned" });
    const env = captureEnv(win);
    // No prototype to read → optional wrappers become silent no-ops.
    expect(() => {
      env.appendChild(EL({}), ND({}));
    }).not.toThrow();
    expect(() => {
      env.scrollIntoView(EL({}));
    }).not.toThrow();
    // Unrelated captures still work.
    expect(env.newRange).toBeDefined();
    env.post({ type: "x" });
    expect(calls.at(-1)).toBe("post:x:*");
  });

  it("should tolerate a null, primitive or function parent window", () => {
    const win = winFor();
    for (const parent of [null, 42, () => undefined]) {
      win.parent = parent as unknown as Record<string, unknown>;
      const env = captureEnv(win);
      expect(() => {
        env.post({ type: "x" });
      }).not.toThrow();
    }
  });

  it("should swallow a throwing postMessage (a function-shaped poison)", () => {
    const win = winFor();
    win.parent["postMessage"] = () => {
      throw new Error("poisoned");
    };
    const env = captureEnv(win);
    expect(() => {
      env.post({ type: "x" });
    }).not.toThrow();
  });

  it("should swallow a throwing getRangeAt and scrollIntoView", () => {
    calls.length = 0;
    const win = winFor();
    (win["Selection"] as { prototype?: Record<string, unknown> }).prototype = {
      getRangeAt() {
        throw new Error("poisoned");
      },
    };
    (win["Element"] as { prototype?: Record<string, unknown> }).prototype = {
      scrollIntoView() {
        throw new Error("poisoned");
      },
    };
    const env = captureEnv(win);
    expect(env.rangeAt?.({ rangeCount: 1, isCollapsed: false }, 0)).toBeUndefined();
    expect(() => {
      env.scrollIntoView(EL({}));
    }).not.toThrow();
  });

  it("should map a DOMRect with only left/top to x/y and default missing sizes", () => {
    const win = winFor();
    (win["Range"] as { prototype?: Record<string, unknown> }).prototype = {
      setStart() {
        return null;
      },
      setEnd() {
        return null;
      },
      getBoundingClientRect() {
        return { left: 8, top: 9 };
      },
    };
    const env = captureEnv(win);
    expect(env.rangeRect?.(RG({}))).toEqual({ x: 8, y: 9, width: 0, height: 0 });
  });

  it("should zero a rect with no position fields at all", () => {
    const win = winFor();
    (win["Range"] as { prototype?: Record<string, unknown> }).prototype = {
      setStart() {
        return null;
      },
      setEnd() {
        return null;
      },
      getBoundingClientRect() {
        return {};
      },
    };
    const env = captureEnv(win);
    expect(env.rangeRect?.(RG({}))).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("should prefer x/y when the rect exposes them", () => {
    const win = winFor();
    (win["Range"] as { prototype?: Record<string, unknown> }).prototype = {
      setStart() {
        return null;
      },
      setEnd() {
        return null;
      },
      getBoundingClientRect() {
        return { x: 1, y: 2, left: 8, top: 9, width: 3, height: 4 };
      },
    };
    const env = captureEnv(win);
    expect(env.rangeRect?.(RG({}))).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });

  it("should degrade when adoptedStyleSheets is absent or the ctor is missing", () => {
    const winNoCtor = winFor({ CSSStyleSheet: undefined });
    let env = captureEnv(winNoCtor);
    expect(env.adoptSheet).toBeUndefined();

    const winNoProp = winFor();
    delete winNoProp.document["adoptedStyleSheets"];
    env = captureEnv(winNoProp);
    expect(env.adoptSheet).toBeUndefined();

    const winNoCss = winFor({ CSS: undefined });
    env = captureEnv(winNoCss);
    expect(env.highlightRegistry).toBeUndefined();
  });
});

describe("annotator index", () => {
  it("should boot the engine when a window exists", async () => {
    calls.length = 0;
    vi.resetModules();
    const win = winFor();
    vi.stubGlobal("window", win);
    const { bootstrap } = await import("../src/annotator/index.ts");
    bootstrap(win);
    expect(calls.filter((c) => c.startsWith("post:"))).toHaveLength(2); // entry + explicit call
    vi.unstubAllGlobals();
  });
});
