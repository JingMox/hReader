// This layer covers the search panel's focus lifecycle (issue #54): a hidden input must
// never keep DOM focus. Chrome only collects focus off a display:none element at the next
// rendering step, so a `/` keydown landing in that window still targets the hidden input
// and the editable guard in `keys.ts` swallows it — the "panel did not reopen" flake.
// The rig drives the real `createDomHost` + `createStore` against the fake document's
// focus scope, so `doc.activeElement` is the same truth a browser would report.

import { describe, expect, it } from "vitest";

import { createDomHost } from "../src/dom.ts";
import type { Schedule } from "../src/flash.ts";
import type { SearchHit, SearchReply } from "../src/guard.ts";
import { intentOf } from "../src/keys.ts";
import { createStore, type Store } from "../src/store.ts";
import { mountSearch } from "../src/widgets/search.ts";
import { createFakeDocument, type FakeDocument, type FakeElement } from "./support/fake-dom.ts";
import { stateOf } from "./support/fake-host.ts";

const ROOT = "#hr-root";
const PANEL = `${ROOT} #hr-search-panel`;
const INPUT = `${ROOT} #hr-search-input`;
const HINT = `${ROOT} #hr-search-hint`;
const DOCS = `${ROOT} #hr-search-docs`;
const DOCS_TITLE = `${ROOT} #hr-search-docs-title`;
const DOCS_LIST = `${ROOT} #hr-search-docs-list`;
const ANNS = `${ROOT} #hr-search-anns`;
const ANNS_TITLE = `${ROOT} #hr-search-anns-title`;
const ANNS_LIST = `${ROOT} #hr-search-anns-list`;
const STATUS = `${ROOT} #hr-hint`;

interface Pending {
  readonly query: string;
  readonly resolve: (reply: SearchReply) => void;
  readonly reject: (cause: unknown) => void;
}

interface Rig {
  readonly doc: FakeDocument;
  readonly store: Store;
  readonly panel: FakeElement;
  readonly input: FakeElement;
  readonly rootEl: FakeElement;
  readonly opened: SearchHit[];
  readonly fetches: Pending[];
  readonly timers: { run: () => void; cancelled: boolean }[];
}

const mountPanel = (): Rig => {
  const doc = createFakeDocument();
  const rootEl = doc.element("div");
  const panel = doc.element("div");
  panel.setAttribute("hidden", "");
  const input = doc.element("input");
  input.value = "";
  const parts: readonly (readonly [string, FakeElement])[] = [
    [ROOT, rootEl],
    [PANEL, panel],
    [INPUT, input],
    [HINT, doc.element("p")],
    [STATUS, doc.element("span")],
    [DOCS, doc.element("section")],
    [DOCS_TITLE, doc.element("h4")],
    [DOCS_LIST, doc.element("ul")],
    [ANNS, doc.element("section")],
    [ANNS_TITLE, doc.element("h4")],
    [ANNS_LIST, doc.element("ul")],
  ];
  for (const [selector, element] of parts) doc.bySelector.set(selector, element);
  const store = createStore(stateOf());
  const opened: SearchHit[] = [];
  const fetches: Pending[] = [];
  const timers: Rig["timers"] = [];
  const schedule: Schedule = (_ms, run) => {
    const timer = { run, cancelled: false };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  const widget = mountSearch({
    host: createDomHost(doc),
    parent: ROOT,
    fetch: (query) =>
      new Promise<SearchReply>((resolve, reject) => {
        fetches.push({ query, resolve, reject });
      }),
    openHit: (hit) => {
      opened.push(hit);
    },
    onIntent: (intent) => {
      store.dispatch(intent);
    },
    schedule,
  });
  store.subscribe((next) => {
    widget.update(next);
  });
  return { doc, store, panel, input, rootEl, opened, fetches, timers };
};

/** The window-level `keydown` path exactly as `keySourceOf` sees it: the event targets whatever holds DOM focus right now. */
const keydown = (rig: Rig, key: string): void => {
  const intent = intentOf({ key, target: rig.doc.activeElement }, rig.store.get());
  if (intent !== undefined) rig.store.dispatch(intent);
};

const esc = (rig: Rig): void => {
  rig.input.fire("keydown", rig.input, { key: "Escape" });
};

const type = (rig: Rig, value: string): void => {
  rig.input.value = value;
  rig.input.fire("input", rig.input);
};

const isOpen = (rig: Rig): boolean => rig.panel.getAttribute("hidden") === null;

const focusCalls = (rig: Rig): readonly string[] =>
  rig.input.calls.filter((call) => call === "focus");

const hitOf = (over: Partial<SearchHit> = {}): SearchHit => ({
  path: "doc.html",
  title: "标题",
  kind: "doc",
  score: 1,
  snippet: "一段正文",
  highlights: [],
  ...over,
});

const replyOf = (results: readonly SearchHit[]): SearchReply => ({
  results,
  total: results.length,
  combine: "and",
  truncated: false,
  diagnostics: [],
});

describe("search widget · focus lifecycle", () => {
  it("should leave an empty focused input when the panel reopens after Esc", () => {
    const rig = mountPanel();
    keydown(rig, "/");
    type(rig, "abc");
    esc(rig);

    keydown(rig, "/");

    expect(isOpen(rig)).toBe(true);
    expect(rig.input.value).toBe("");
    expect(rig.doc.activeElement).toBe(rig.input);
  });

  it("should reopen the panel when / is pressed immediately after Esc", () => {
    const rig = mountPanel();
    keydown(rig, "/");
    esc(rig);

    // The counterexample behind #54: right after close, DOM focus must already be off
    // the hidden input — otherwise this / lands on it and the editable guard eats it.
    expect(rig.doc.activeElement).not.toBe(rig.input);
    keydown(rig, "/");
    expect(isOpen(rig)).toBe(true);
  });

  it("should restore focus to the element that had it when the panel opened", () => {
    const rig = mountPanel();
    const button = rig.doc.element("button");
    button.focus?.();
    keydown(rig, "/");
    esc(rig);

    expect(rig.doc.activeElement).toBe(button);
  });

  it("should move focus off the input when the pre-open element was removed while open", () => {
    const rig = mountPanel();
    const button = rig.doc.element("button");
    button.focus?.();
    keydown(rig, "/");
    button.isConnected = false;
    esc(rig);

    expect(rig.doc.activeElement).not.toBe(rig.input);
  });

  it("should move focus off the input when a hit is chosen with Enter", async () => {
    const rig = mountPanel();
    keydown(rig, "/");
    type(rig, "词");
    rig.timers.at(-1)?.run();
    rig.fetches[0]?.resolve(replyOf([hitOf()]));
    await Promise.resolve();

    rig.input.fire("keydown", rig.input, { key: "Enter" });

    expect(rig.opened).toHaveLength(1);
    expect(isOpen(rig)).toBe(false);
    expect(rig.doc.activeElement).not.toBe(rig.input);
  });

  it("should keep a single focused empty panel when opened twice in a row", () => {
    const rig = mountPanel();
    keydown(rig, "/");
    // A second / targets the focused input (editable → swallowed), and the desktop
    // ⌘K event only re-dispatches searchOpened into an already-open state.
    keydown(rig, "/");
    rig.rootEl.fire("hr-search-open", rig.rootEl);

    expect(isOpen(rig)).toBe(true);
    expect(rig.input.value).toBe("");
    expect(rig.doc.activeElement).toBe(rig.input);
    expect(focusCalls(rig)).toHaveLength(1);
  });

  it("should not open the panel when / is typed inside an editable element outside it", () => {
    const rig = mountPanel();
    const textarea = rig.doc.element("textarea");
    textarea.focus?.();
    keydown(rig, "/");
    const editable = rig.doc.element("div");
    editable.isContentEditable = true;
    editable.focus?.();
    keydown(rig, "/");

    expect(isOpen(rig)).toBe(false);
  });
});
