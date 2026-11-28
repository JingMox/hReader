// This layer covers D61 search wiring in the **injected entry point**: `io.json`'s `/api/search`
// path + guard, `navigateToDoc`'s browser/desktop arms, and the `sessionStorage` annotation stash
// round-trip. Shares main-stubs' globals with main-inject; window shape gets assign/sessionStorage patched in per case.

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Host, TargetLike } from "../src/dom.ts";
import type { AppIo } from "../src/main.ts";
import {
  ARTICLE,
  CSS,
  flush,
  installGlobals,
  model,
  outline,
  stubs,
  themes,
} from "./support/main-stubs.ts";

const ROOT = "#hr-root";
const INPUT = `${ROOT} #hr-search-input`;
const FOCUS_KEY = "hr-search-focus";

/** `window` after stub install (installGlobals only sets href; assign/sessionStorage/bridge are patched per case). */
interface SearchWindow {
  location: { href: string; assign?: (url: string) => void };
  sessionStorage?: {
    getItem: (key: string) => string | null | undefined;
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
  };
  __HR_DESKTOP_CTX__?: { bridgeToken?: string };
}

const winOf = (): SearchWindow => (globalThis as unknown as { window: SearchWindow }).window;

interface RecHost {
  readonly host: Host;
  readonly scrolls: string[];
  readonly classes: readonly (readonly [string, string, string])[];
  readonly fire: (selector: string, type: string, event: unknown) => void;
}

/** Recording Host: `on` handlers keyed by `${selector}|${type}`, `fire` replays verbatim (same convention as main-inject). */
const recordingHostOf = (has: (selector: string) => boolean): RecHost => {
  const scrolls: string[] = [];
  const classes: [string, string, string][] = [];
  const handlers = new Map<string, (target: TargetLike) => void>();
  const noop = (): void => undefined;
  const host: Host = {
    text: noop,
    attr: noop,
    html: noop,
    cls: (selector, name, on) => {
      classes.push([selector, name, on ? "1" : "0"]);
    },
    children: noop,
    blocks: () => new Map(),
    blockHtml: noop,
    removeBlock: noop,
    on: (selector, type, handler) => {
      handlers.set(`${selector}|${type}`, handler);
      return () => undefined;
    },
    scrollTo: (selector) => {
      scrolls.push(selector);
    },
    all: () => [],
    has,
    focus: noop,
    destroy: noop,
  };
  return {
    host,
    scrolls,
    classes,
    fire: (selector, type, event) => {
      handlers.get(`${selector}|${type}`)?.(event as TargetLike);
    },
  };
};

const SEARCH_HIT = {
  path: "other.html",
  title: "他文档",
  kind: "doc" as const,
  score: 1,
  snippet: "一段正文",
  highlights: [] as readonly (readonly [number, number])[],
};
const ANN_HIT = { ...SEARCH_HIT, kind: "annotation" as const, annotationId: "an-9" };

/** Injected IO: `/api/search` returns `searchReply`; other paths replay per the main-entry flow. */
const ioOf = (searchReply: unknown, asked: string[] = []): AppIo => ({
  text: (path) => {
    asked.push(path);
    return Promise.resolve(path.startsWith("/api/theme/") ? CSS : ARTICLE);
  },
  json: (path, guard) => {
    asked.push(path);
    const candidate: unknown = path.startsWith("/api/search")
      ? searchReply
      : path === "/api/theme"
        ? themes
        : path.endsWith("/info")
          ? { revision: "r1", cls: "managed" }
          : path.endsWith("/model")
            ? model
            : path.endsWith("/outline")
              ? outline
              : path.endsWith("/annotations")
                ? {
                    annotations: [{ id: "an-9", nodeId: "hr-a", note: "批注", status: "pending" }],
                    lost: [],
                  }
                : { chunks: [], degraded: false };
    return guard(candidate)
      ? Promise.resolve(candidate)
      : Promise.reject(new Error(`${path} → 响应形状不符`));
  },
});

const THEMES = { themes: ["atelier-editorial"], default: "atelier-editorial" };

/** Real `/` → input → real 150ms debounce → Enter: lands on the hit at flat-order `index`. */
const openAndEnter = async (fire: RecHost["fire"], index: number): Promise<void> => {
  stubs.keyHandlers[0]?.({ key: "/" });
  fire(INPUT, "input", { value: "词" });
  await flush(200);
  for (let i = 0; i < index; i += 1) fire(INPUT, "keydown", { key: "ArrowDown" });
  fire(INPUT, "keydown", { key: "Enter" });
};

const storageOf = (
  map: Map<string, string>,
  over: Partial<SearchWindow["sessionStorage"] & object> = {},
): NonNullable<SearchWindow["sessionStorage"]> => ({
  getItem: (key) => map.get(key) ?? null,
  setItem: (key, value) => {
    map.set(key, value);
  },
  removeItem: (key) => {
    map.delete(key);
  },
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("main-search · navigateToDoc (hit-navigation arms)", () => {
  it("should fetch /api/search on the debounce and assign /?doc= for a doc hit", async () => {
    installGlobals("doc.html", "http://x/?doc=doc.html");
    const assign = vi.fn();
    winOf().location.assign = assign;
    const asked: string[] = [];
    const { host, fire } = recordingHostOf(() => true);
    const { bootWith } = await import("../src/main.ts");

    bootWith({
      docId: "doc.html",
      themes: THEMES,
      documentHtml: ARTICLE,
      io: ioOf({ results: [SEARCH_HIT], total: 1, combine: "and", truncated: false }, asked),
      host,
    });
    await openAndEnter(fire, 0);

    const url = asked.find((path) => path.startsWith("/api/search?"));
    expect(url).toBe(`/api/search?q=${encodeURIComponent("词")}&limit=20`);
    expect(assign).toHaveBeenCalledWith("/?doc=other.html");
  });

  it("should route a doc hit through the desktop /open bridge when a bridge token exists", async () => {
    installGlobals("doc.html", "http://x/?doc=doc.html");
    const assign = vi.fn();
    winOf().location.assign = assign;
    winOf().__HR_DESKTOP_CTX__ = { bridgeToken: "t k" };
    const { host, fire } = recordingHostOf(() => true);
    const { bootWith } = await import("../src/main.ts");

    bootWith({
      docId: "doc.html",
      themes: THEMES,
      documentHtml: ARTICLE,
      io: ioOf({ results: [SEARCH_HIT], total: 1, combine: "and", truncated: false }),
      host,
    });
    await openAndEnter(fire, 0);

    expect(assign).toHaveBeenCalledWith("http://hr-desktop.local/open?doc=other.html&t=t%20k");
  });

  it("should stash the annotation target in sessionStorage and navigate for an annotation hit", async () => {
    installGlobals("doc.html", "http://x/?doc=doc.html");
    const assign = vi.fn();
    winOf().location.assign = assign;
    const map = new Map<string, string>();
    winOf().sessionStorage = storageOf(map);
    const { host, fire } = recordingHostOf(() => true);
    const { bootWith } = await import("../src/main.ts");

    bootWith({
      docId: "doc.html",
      themes: THEMES,
      documentHtml: ARTICLE,
      io: ioOf({ results: [ANN_HIT], total: 1, combine: "and", truncated: false }),
      host,
    });
    await openAndEnter(fire, 0);

    expect(map.get(FOCUS_KEY)).toBe(JSON.stringify({ doc: "other.html", ann: "an-9" }));
    expect(assign).toHaveBeenCalledWith("/?doc=other.html");
  });

  it("should still navigate when sessionStorage.setItem throws (focus degrades, navigation keeps)", async () => {
    installGlobals("doc.html", "http://x/?doc=doc.html");
    const assign = vi.fn();
    winOf().location.assign = assign;
    winOf().sessionStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => undefined,
    };
    const { host, fire } = recordingHostOf(() => true);
    const { bootWith } = await import("../src/main.ts");

    bootWith({
      docId: "doc.html",
      themes: THEMES,
      documentHtml: ARTICLE,
      io: ioOf({ results: [ANN_HIT], total: 1, combine: "and", truncated: false }),
      host,
    });
    await openAndEnter(fire, 0);

    expect(assign).toHaveBeenCalledWith("/?doc=other.html");
  });
});

describe("main-search · takeSearchFocus (consuming the stash)", () => {
  it("should focus the stashed annotation's anchor block after boot", async () => {
    installGlobals("doc.html", "http://x/?doc=doc.html");
    const map = new Map([[FOCUS_KEY, JSON.stringify({ doc: "doc.html", ann: "an-9" })]]);
    const { host, scrolls, classes } = recordingHostOf(() => true);
    // Import before installing the stash: the first import in this file runs `main()`
    // against the current globals, and `takeSearchFocus` inside it would drain the
    // stash before `bootWith` ever sees it (order-dependent under --sequence.shuffle).
    const { bootWith } = await import("../src/main.ts");
    winOf().sessionStorage = storageOf(map);

    bootWith({
      docId: "doc.html",
      themes: THEMES,
      documentHtml: ARTICLE,
      io: ioOf({ results: [], total: 0, combine: "and", truncated: false }),
      host,
    });
    await flush();

    expect(map.has(FOCUS_KEY)).toBe(false);
    expect(scrolls).toContain(`${ROOT} [data-hr-id="hr-a"]`);
    expect(classes).toContainEqual([`${ROOT} [data-hr-id="hr-a"]`, "hr-note-target", "1"]);
  });

  it("should consume but not focus a stash written for another doc", async () => {
    installGlobals("doc.html", "http://x/?doc=doc.html");
    const map = new Map([[FOCUS_KEY, JSON.stringify({ doc: "other.html", ann: "an-9" })]]);
    const { host, classes } = recordingHostOf(() => true);
    const { bootWith } = await import("../src/main.ts");
    winOf().sessionStorage = storageOf(map);

    bootWith({
      docId: "doc.html",
      themes: THEMES,
      documentHtml: ARTICLE,
      io: ioOf({ results: [], total: 0, combine: "and", truncated: false }),
      host,
    });
    await flush();

    expect(map.has(FOCUS_KEY)).toBe(false);
    expect(classes.some((call) => call[1] === "hr-note-target")).toBe(false);
  });

  it("should ignore malformed or wrongly-shaped stashes", async () => {
    installGlobals("doc.html", "http://x/?doc=doc.html");
    const map = new Map([[FOCUS_KEY, "not-json"]]);
    const { host, classes } = recordingHostOf(() => true);
    const { bootWith } = await import("../src/main.ts");
    winOf().sessionStorage = storageOf(map);

    bootWith({
      docId: "doc.html",
      themes: THEMES,
      documentHtml: ARTICLE,
      io: ioOf({ results: [], total: 0, combine: "and", truncated: false }),
      host,
    });
    await flush();

    expect(classes.some((call) => call[1] === "hr-note-target")).toBe(false);

    installGlobals("doc.html", "http://x/?doc=doc.html");
    winOf().sessionStorage = storageOf(
      new Map([[FOCUS_KEY, JSON.stringify({ doc: "doc.html", ann: 7 })]]),
    );
    const again = recordingHostOf(() => true);
    bootWith({
      docId: "doc.html",
      themes: THEMES,
      documentHtml: ARTICLE,
      io: ioOf({ results: [], total: 0, combine: "and", truncated: false }),
      host: again.host,
    });
    await flush();
    expect(again.classes.some((call) => call[1] === "hr-note-target")).toBe(false);
  });

  it("should return undefined on an explicit null read without removing anything", async () => {
    installGlobals("doc.html", "http://x/?doc=doc.html");
    let removed = 0;
    const { host } = recordingHostOf(() => true);
    const { bootWith } = await import("../src/main.ts");
    winOf().sessionStorage = {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => {
        removed += 1;
      },
    };

    bootWith({
      docId: "doc.html",
      themes: THEMES,
      documentHtml: ARTICLE,
      io: ioOf({ results: [], total: 0, combine: "and", truncated: false }),
      host,
    });
    await flush();

    expect(removed).toBe(0);
  });
});
