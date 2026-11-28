// This layer owns: the library-search panel (opened by `/`, or ⌘K on the desktop shell).
// Safety invariants: title/path/snippet only ever land via `NodeSpec.text` → textContent,
// never innerHTML; `highlights` offsets are clamped to the snippet bounds and invalid pairs
// dropped before runs are cut into `mark` text; `path` is used for navigation only, never
// interpolated into HTML or a selector.

import type { ElementLike, Host, NodeSpec, TargetLike } from "../dom.ts";
import type { Schedule } from "../flash.ts";
import type { SearchHit, SearchReply } from "../guard.ts";
import type { ReaderIntent, ReaderState } from "../state.ts";
import { COPY } from "./copy.ts";
import type { Widget } from "./library.ts";

/** Same bound as core's `SEARCH_LIMITS.queryChars`: the client rejects overlong queries without a request. */
const QUERY_MAX = 200;
const DEBOUNCE_MS = 150;

interface SearchDeps {
  readonly host: Host;
  readonly parent: string;
  /** `GET /api/search?q=…&limit=…` wrapper; injected by `main.ts`/`boot.ts`, faked in tests. */
  readonly fetch: (query: string) => Promise<SearchReply>;
  /** Open one hit: navigation/annotation-focus semantics live in `boot.ts` (the widget never reads `path`). */
  readonly openHit: (hit: SearchHit) => void;
  /** Panel open/close goes through store intents (`searchOpened`/`panelClosed`) — the single state exit. */
  readonly onIntent: (intent: ReaderIntent) => void;
  /** Debounce timer: the same `Schedule` injection point as `flash` (tests pass a manual clock). */
  readonly schedule: Schedule;
}

/** Clamp highlight pairs to the snippet bounds: negatives lift to 0, overflows cap at the end, reversed/empty pairs are dropped. */
const normalizePairs = (
  snippet: string,
  highlights: readonly (readonly [number, number])[],
): readonly (readonly [number, number])[] => {
  const pairs: [number, number][] = [];
  for (const [rawStart, rawEnd] of highlights) {
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) continue;
    const start = Math.max(0, Math.min(snippet.length, Math.trunc(rawStart)));
    const end = Math.max(0, Math.min(snippet.length, Math.trunc(rawEnd)));
    if (end <= start) continue;
    pairs.push([start, end]);
  }
  pairs.sort(([sa, ea], [sb, eb]) => sa - sb || ea - eb);
  return pairs;
};

/** snippet → plain-text runs: plain ranges become `span`, hit ranges become `mark`; later pairs that overlap drop their covered part. */
const snippetSpecs = (
  snippet: string,
  highlights: readonly (readonly [number, number])[],
): readonly NodeSpec[] => {
  const runs: NodeSpec[] = [];
  let pos = 0;
  for (const [start, end] of normalizePairs(snippet, highlights)) {
    if (end <= pos) continue;
    const from = Math.max(start, pos);
    if (from > pos) runs.push({ tag: "span", text: snippet.slice(pos, from) });
    runs.push({ tag: "mark", text: snippet.slice(from, end) });
    pos = end;
  }
  if (pos < snippet.length) runs.push({ tag: "span", text: snippet.slice(pos) });
  return runs.length === 0 ? [{ tag: "span", text: "" }] : runs;
};

export const mountSearch = (deps: SearchDeps): Widget => {
  const { host, parent } = deps;
  // SP_* prefixes keep these selector consts from colliding with same-named ones in other
  // widgets (the static wiring check keys its table by const name).
  const SP_PANEL = `${parent} #hr-search-panel`;
  const SP_INPUT = `${parent} #hr-search-input`;
  const SP_HINT = `${parent} #hr-search-hint`;
  const SP_DOCS = `${parent} #hr-search-docs`;
  const SP_DOCS_TITLE = `${parent} #hr-search-docs-title`;
  const SP_DOCS_LIST = `${parent} #hr-search-docs-list`;
  const SP_ANNS = `${parent} #hr-search-anns`;
  const SP_ANNS_TITLE = `${parent} #hr-search-anns-title`;
  const SP_ANNS_LIST = `${parent} #hr-search-anns-list`;
  const SP_STATUS = `${parent} #hr-hint`;

  let open = false;
  let hits: readonly SearchHit[] = [];
  let active = 0;
  /** Monotonic request id: a late response whose id no longer matches is dropped (stale never overwrites fresh). */
  let seq = 0;
  let cancelPending: (() => void) | undefined;
  /** The current input text (input events update it; query() reads it when firing). */
  let pendingQuery = "";
  /** The element that held DOM focus when the panel opened — restored on close (dialog semantics). */
  let restoreFocus: ElementLike | undefined;

  const hint = (text: string): void => {
    host.text(SP_HINT, text);
    host.text(SP_STATUS, text);
  };

  const paintActive = (index: number, on: boolean): void => {
    host.cls(`${SP_PANEL} [data-hr-index="${String(index)}"]`, "search__item--on", on);
  };

  const clearLists = (): void => {
    hits = [];
    active = 0;
    host.children(SP_DOCS_LIST, []);
    host.children(SP_ANNS_LIST, []);
    host.attr(SP_DOCS, "hidden", "");
    host.attr(SP_ANNS, "hidden", "");
  };

  const itemSpec = (hit: SearchHit, index: number): NodeSpec => ({
    tag: "li",
    attrs: {
      class: `search__item${index === active ? " search__item--on" : ""}`,
      "data-hr-index": String(index),
      role: "option",
    },
    children: [
      {
        tag: "p",
        attrs: { class: "search__title" },
        children: [
          {
            tag: "span",
            attrs: { class: "search__kind" },
            text: hit.kind === "doc" ? COPY.searchDocs : COPY.searchAnns,
          },
          { tag: "span", text: hit.title === "" ? hit.path : hit.title },
        ],
      },
      {
        tag: "p",
        attrs: { class: "search__snippet" },
        children: snippetSpecs(hit.snippet, hit.highlights),
      },
    ],
  });

  const render = (reply: SearchReply): void => {
    const docs = reply.results.filter((hit) => hit.kind === "doc");
    const anns = reply.results.filter((hit) => hit.kind === "annotation");
    hits = [...docs, ...anns];
    active = 0;
    host.children(
      SP_DOCS_LIST,
      docs.map((hit, index) => itemSpec(hit, index)),
    );
    host.children(
      SP_ANNS_LIST,
      anns.map((hit, index) => itemSpec(hit, docs.length + index)),
    );
    host.attr(SP_DOCS, "hidden", docs.length === 0 ? "" : undefined);
    host.attr(SP_ANNS, "hidden", anns.length === 0 ? "" : undefined);
    if (hits.length === 0) hint(COPY.searchEmpty);
    else if (reply.combine === "or") hint(COPY.searchPartial);
    else hint("");
  };

  const query = (): void => {
    seq += 1;
    const mine = seq;
    const input = pendingQuery;
    hint(COPY.searchLoading);
    void deps.fetch(input).then(
      (reply) => {
        if (mine !== seq || !open) return;
        render(reply);
      },
      (cause: unknown) => {
        if (mine !== seq || !open) return;
        clearLists();
        hint(`${COPY.searchError}${cause instanceof Error ? cause.message : String(cause)}`);
      },
    );
  };

  const onInput = (target: TargetLike): void => {
    pendingQuery = target.value ?? "";
    cancelPending?.();
    cancelPending = undefined;
    seq += 1;
    if (pendingQuery.trim() === "") {
      clearLists();
      hint(COPY.searchIdle);
      return;
    }
    if (Array.from(pendingQuery).length > QUERY_MAX) {
      clearLists();
      hint(COPY.searchTooLong);
      return;
    }
    cancelPending = deps.schedule(DEBOUNCE_MS, () => {
      cancelPending = undefined;
      query();
    });
  };

  const choose = (index: number): void => {
    const hit = hits[index];
    if (hit === undefined) return;
    deps.onIntent({ kind: "panelClosed" });
    deps.openHit(hit);
  };

  const move = (delta: number): void => {
    if (hits.length === 0) return;
    paintActive(active, false);
    active = (active + delta + hits.length) % hits.length;
    paintActive(active, true);
    host.scrollTo(`${SP_PANEL} [data-hr-index="${String(active)}"]`);
  };

  const onKey = (target: TargetLike): void => {
    if (target.key === "ArrowDown") move(1);
    else if (target.key === "ArrowUp") move(-1);
    else if (target.key === "Enter") choose(active);
    else if (target.key === "Escape") deps.onIntent({ kind: "panelClosed" });
  };

  const onClick = (target: TargetLike): void => {
    const indexText = target.closest?.("[data-hr-index]")?.getAttribute("data-hr-index");
    if (indexText === null || indexText === undefined) return;
    choose(Number(indexText));
  };

  const show = (): void => {
    // Snapshot before focus moves: close() hands focus back to this element.
    restoreFocus = host.activeElement?.() ?? undefined;
    seq += 1;
    cancelPending?.();
    cancelPending = undefined;
    pendingQuery = "";
    clearLists();
    host.text(SP_INPUT, "");
    host.attr(SP_PANEL, "hidden", undefined);
    hint(COPY.searchIdle);
    host.focus?.(SP_INPUT);
  };

  const hide = (): void => {
    seq += 1;
    cancelPending?.();
    cancelPending = undefined;
    clearLists();
    host.attr(SP_PANEL, "hidden", "");
    hint("");
    const target = restoreFocus;
    restoreFocus = undefined;
    // Chrome keeps a now-hidden focused element as activeElement until the next
    // rendering step; a `/` keydown landing in that window still targets the
    // input and the editable-target guard swallows it, so the panel never
    // reopens (issue #54). Hand focus back only while the panel holds it —
    // focus that moved elsewhere during the session belongs to the user.
    if (host.focused?.(SP_INPUT) !== true) return;
    if (target !== undefined && target.isConnected !== false) target.focus?.();
    // The restore above silently does nothing when the target can no longer
    // take focus; blur runs unconditionally because it only releases the input
    // while the input still holds focus.
    host.blur?.(SP_INPUT);
  };

  // `data-hr-search` is the capability marker: the desktop ⌘K handler probes it before
  // dispatching `hr-search-open`; pages without it (empty workbench etc.) degrade to a hint.
  host.attr(parent, "data-hr-search", "");
  host.attr(SP_INPUT, "placeholder", COPY.searchPlaceholder);
  host.attr(SP_INPUT, "aria-label", COPY.searchTitle);
  host.text(SP_DOCS_TITLE, COPY.searchDocs);
  host.text(SP_ANNS_TITLE, COPY.searchAnns);
  host.on(SP_INPUT, "input", onInput);
  host.on(SP_INPUT, "keydown", onKey);
  host.on(SP_PANEL, "click", onClick);
  host.on(parent, "hr-search-open", () => {
    deps.onIntent({ kind: "searchOpened" });
  });

  const update = (next: ReaderState): void => {
    if (next.searchOpen === open) return;
    open = next.searchOpen;
    if (open) show();
    else hide();
  };

  return { update };
};
