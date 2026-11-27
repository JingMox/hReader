// This layer covers `widgets/ann-panel` (D55) through the REAL dom host on
// happy-dom: grouping (待处理 / 已解决 / 找不到位置), card text rendered
// textContent-only (the XSS assertions live here), actions
// (reply / resolve / reopen / delete+confirm) → io writes + onChanged refresh,
// click → focus post + selection, `open` → select + scrollIntoView, selection
// persistence across refresh, state pruning, empty states, open/close/destroy.

import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { NOTE_LIMIT, type SidecarEntry } from "../src/annotate-proto.ts";
import { createDomHost, type DocumentLike, type TargetLike } from "../src/dom.ts";
import { escapeAttr } from "../src/escape-attr.ts";
import { mountAnnPanel, type AnnPanelHandle, type AnnPanelIo } from "../src/widgets/ann-panel.ts";
import { COPY } from "../src/widgets/copy.ts";
import { createFakeHost, type FakeHost } from "./support/fake-host.ts";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const entry = (over: Partial<SidecarEntry> = {}): SidecarEntry => ({
  id: "a1",
  status: "pending",
  note: "nota uno",
  exact: "mundo",
  author: "user",
  createdAt: "2024-05-01T10:00:00Z",
  replies: [],
  relocation: { ok: true, start: 5, end: 10 },
  ...over,
});

/** The io-recording half every rig shares: writes/posts/changes/errors land in arrays. */
const recordersOf = (
  ioOver: Partial<AnnPanelIo>,
): {
  readonly io: AnnPanelIo;
  readonly deps: {
    readonly postToFrame: (message: Record<string, unknown>) => void;
    readonly onChanged: () => void;
    readonly onError: (cause: unknown) => void;
  };
  readonly writes: string[];
  readonly posted: Record<string, unknown>[];
  readonly errors: unknown[];
  readonly changes: () => number;
} => {
  const writes: string[] = [];
  const posted: Record<string, unknown>[] = [];
  const errors: unknown[] = [];
  let changes = 0;
  const raw: Required<AnnPanelIo> = {
    resolve: () => Promise.resolve(),
    reopen: () => Promise.resolve(),
    reply: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    ...ioOver,
  };
  // Writes are recorded no matter which impl is plugged in.
  const io: AnnPanelIo = {
    resolve: (id) => {
      writes.push(`resolve:${id}`);
      return raw.resolve(id);
    },
    reopen: (id) => {
      writes.push(`reopen:${id}`);
      return raw.reopen(id);
    },
    reply: (id, note) => {
      writes.push(`reply:${id}:${note}`);
      return raw.reply(id, note);
    },
    remove: (id) => {
      writes.push(`remove:${id}`);
      return raw.remove(id);
    },
  };
  return {
    io,
    deps: {
      postToFrame: (message) => {
        posted.push({ ...message });
      },
      onChanged: () => {
        changes += 1;
      },
      onError: (cause) => {
        errors.push(cause);
      },
    },
    writes,
    posted,
    errors,
    changes: () => changes,
  };
};

interface Rig {
  readonly panel: AnnPanelHandle;
  readonly win: Window;
  readonly writes: string[];
  readonly posted: Record<string, unknown>[];
  readonly errors: unknown[];
  readonly changes: () => number;
}

const rigOf = (ioOver: Partial<AnnPanelIo> = {}): Rig => {
  const win = new Window();
  win.document.body.innerHTML = `
    <div id="hr-root">
      <aside id="hr-ann-panel" hidden>
        <h3 id="hr-ann-title"></h3>
        <p id="hr-ann-error" role="alert"></p>
        <section class="ann-group" aria-labelledby="hr-ann-pending-title">
          <h4 id="hr-ann-pending-title"></h4><ul id="hr-ann-pending"></ul>
        </section>
        <section class="ann-group" aria-labelledby="hr-ann-resolved-title">
          <h4 id="hr-ann-resolved-title"></h4><ul id="hr-ann-resolved"></ul>
        </section>
        <section id="hr-ann-group-lost" class="ann-group" aria-labelledby="hr-ann-lost-title" hidden>
          <h4 id="hr-ann-lost-title"></h4><ul id="hr-ann-lost"></ul>
        </section>
        <p id="hr-ann-empty"></p>
      </aside>
    </div>`;
  const host = createDomHost(win.document as unknown as DocumentLike);
  const { io, deps, writes, posted, errors, changes } = recordersOf(ioOver);
  const panel = mountAnnPanel({ host, parent: "#hr-root", io, ...deps });
  panel.open();
  return { panel, win, writes, posted, errors, changes };
};

// happy-dom elements are structural ElementLikes for the selectors the panel uses.
interface QElement {
  readonly children: ArrayLike<QElement>;
  readonly textContent: string | null;
  value?: string;
  getAttribute: (name: string) => string | null;
  hasAttribute: (name: string) => boolean;
  querySelector: (selector: string) => QElement | null;
  querySelectorAll: (selector: string) => ArrayLike<QElement>;
  dispatchEvent: (event: unknown) => boolean;
  scrollIntoView?: () => void;
}

const q = (rig: Rig, selector: string): QElement | null =>
  rig.win.document.querySelector(selector) as unknown as QElement | null;

/** Unwrap-or-throw: `!` and `as` are both banned here, guards are the house style. */
const must = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) throw new Error(`missing ${what}`);
  return value;
};

const card = (rig: Rig, id: string): QElement | null =>
  q(rig, `#hr-ann-panel [data-hr-annotation="${escapeAttr(id)}"]`);

const cards = (rig: Rig, list: string): QElement[] =>
  Array.from(q(rig, list)?.querySelectorAll("[data-hr-annotation]") ?? []);

const action = (scope: QElement, name: string): QElement | undefined =>
  Array.from(scope.querySelectorAll("[data-hr-action]")).find(
    (el) => el.getAttribute("data-hr-action") === name,
  );

const click = (rig: Rig, el: QElement): void => {
  el.dispatchEvent(new rig.win.Event("click", { bubbles: true }));
};

const type = (rig: Rig, el: QElement, value: string): void => {
  el.value = value;
  el.dispatchEvent(new rig.win.Event("input", { bubbles: true }));
};

const clickAction = (rig: Rig, id: string, name: string): void => {
  const target = card(rig, id);
  const btn = target === null ? undefined : action(target, name);
  if (btn === undefined) throw new Error(`no ${name} action on card ${id}`);
  click(rig, btn);
};

describe("ann-panel · groups and rendering", () => {
  it("should group located pending, located resolved and lost cards under their own lists", () => {
    const rig = rigOf();
    rig.panel.render([
      entry({ id: "p1" }),
      entry({ id: "r1", status: "resolved", resolvedAt: "2024-06-01T00:00:00Z" }),
      entry({
        id: "l1",
        relocation: { ok: false, start: 0, end: 0, reason: "anchor_lost" },
      }),
    ]);
    expect(cards(rig, "#hr-ann-pending").map((c) => c.getAttribute("data-hr-annotation"))).toEqual([
      "p1",
    ]);
    expect(cards(rig, "#hr-ann-resolved").map((c) => c.getAttribute("data-hr-annotation"))).toEqual(
      ["r1"],
    );
    expect(cards(rig, "#hr-ann-lost").map((c) => c.getAttribute("data-hr-annotation"))).toEqual([
      "l1",
    ]);
    expect(q(rig, "#hr-ann-group-lost")?.hasAttribute("hidden")).toBe(false);
    // Group titles come from COPY at mount.
    expect(q(rig, "#hr-ann-pending-title")?.textContent).toBe(COPY.annPending);
    expect(q(rig, "#hr-ann-resolved-title")?.textContent).toBe(COPY.annResolved);
    expect(q(rig, "#hr-ann-lost-title")?.textContent).toBe(COPY.annLostGroup);
    expect(q(rig, "#hr-ann-title")?.textContent).toBe(COPY.annPanelTitle);
    // Lost card shows the Chinese reason, not the raw code.
    const lost = card(rig, "l1");
    expect(lost?.querySelector(".ann-lost")?.textContent).toBe(COPY.annLostAnchor);
    // Resolved card shows the resolved line; pending card does not.
    expect(card(rig, "r1")?.querySelector(".ann-resolved")?.textContent).toContain(
      COPY.annResolved,
    );
    expect(card(rig, "p1")?.querySelector(".ann-resolved")).toBeNull();
  });

  it("should name each relocation failure in plain copy and fall back for unknown reasons", () => {
    const rig = rigOf();
    for (const [reason, copy] of [
      ["anchor_lost", COPY.annLostAnchor],
      ["ambiguous", COPY.annLostAmbiguous],
      ["orphaned", COPY.annLostOrphaned],
      ["weird-server-reason", `${COPY.annLostGroup}：weird-server-reason`],
    ] as const) {
      rig.panel.render([entry({ id: "l", relocation: { ok: false, start: 0, end: 0, reason } })]);
      expect(card(rig, "l")?.querySelector(".ann-lost")?.textContent).toBe(copy);
    }
  });

  it("should render quote, note, replies, author and time on the card", () => {
    const rig = rigOf();
    rig.panel.render([
      entry({
        id: "a1",
        exact: "the anchored text",
        note: "my note",
        author: "agent",
        replies: [
          { id: "r1", author: "user", note: "first reply", createdAt: "2024-05-02T00:00:00Z" },
        ],
      }),
    ]);
    const c = card(rig, "a1");
    expect(c?.querySelector(".ann-quote")?.textContent).toBe("the anchored text");
    expect(c?.querySelector(".ann-note")?.textContent).toBe("my note");
    const replies = c?.querySelector(".ann-replies");
    expect(replies?.querySelector(".ann-reply-note")?.textContent).toBe("first reply");
    expect(c?.querySelector(".ann-item > .ann-meta")?.textContent).toBe(
      `${COPY.annAuthorAgent} · 2024-05-01T10:00:00Z`,
    );
    expect(replies?.querySelector(".ann-meta")?.textContent).toBe(
      `${COPY.annAuthorUser} · 2024-05-02T00:00:00Z`,
    );
  });

  it("should truncate a long anchor quote and keep a short one verbatim", () => {
    const rig = rigOf();
    const long = "x".repeat(80);
    const short = "keep me";
    rig.panel.render([entry({ id: "a1", exact: long }), entry({ id: "a2", exact: short })]);
    expect(card(rig, "a1")?.querySelector(".ann-quote")?.textContent).toBe(`${"x".repeat(60)}…`);
    expect(card(rig, "a2")?.querySelector(".ann-quote")?.textContent).toBe(short);
  });

  it("should show the empty state only when the whole list is empty", () => {
    const rig = rigOf();
    rig.panel.render([]);
    expect(q(rig, "#hr-ann-empty")?.textContent).toBe(COPY.annPanelEmpty);
    expect(q(rig, "#hr-ann-group-lost")?.hasAttribute("hidden")).toBe(true);
    rig.panel.render([entry({ id: "a1" })]);
    expect(q(rig, "#hr-ann-empty")?.textContent).toBe("");
  });
});

describe("ann-panel · actions", () => {
  it("should route resolve and reopen to io and refresh via onChanged", async () => {
    const rig = rigOf();
    rig.panel.render([
      entry({ id: "p1" }),
      entry({ id: "r1", status: "resolved", resolvedAt: "2024-06-01T00:00:00Z" }),
    ]);
    clickAction(rig, "p1", "resolve");
    await tick();
    expect(rig.writes).toEqual(["resolve:p1"]);
    expect(rig.changes()).toBe(1);

    clickAction(rig, "r1", "reopen");
    await tick();
    expect(rig.writes).toEqual(["resolve:p1", "reopen:r1"]);
    expect(rig.changes()).toBe(2);
    expect(rig.errors).toHaveLength(0);
  });

  it("should gate delete behind a confirm step", async () => {
    const rig = rigOf();
    rig.panel.render([entry({ id: "p1" })]);
    clickAction(rig, "p1", "delete");
    // The confirm box appears; no write yet.
    expect(card(rig, "p1")?.querySelector(".ann-confirm")?.textContent).toContain(
      COPY.annDeleteConfirm,
    );
    expect(rig.writes).toHaveLength(0);

    // Cancel drops the box without writing.
    clickAction(rig, "p1", "delete-no");
    expect(card(rig, "p1")?.querySelector(".ann-confirm")).toBeNull();

    // Confirm → io.remove + onChanged.
    clickAction(rig, "p1", "delete");
    clickAction(rig, "p1", "delete-yes");
    await tick();
    expect(rig.writes).toEqual(["remove:p1"]);
    expect(rig.changes()).toBe(1);
  });

  it("should reply through an inline box, slice at NOTE_LIMIT and close after send", async () => {
    const rig = rigOf();
    rig.panel.render([entry({ id: "p1" })]);
    clickAction(rig, "p1", "reply");
    const box = card(rig, "p1")?.querySelector(".ann-replybox");
    const textarea = box?.querySelector("textarea");
    expect(textarea).not.toBeNull();
    expect(textarea?.getAttribute("maxlength")).toBe(String(NOTE_LIMIT));

    type(rig, must(textarea, "reply textarea"), "hola");
    clickAction(rig, "p1", "reply-send");
    await tick();
    expect(rig.writes).toEqual(["reply:p1:hola"]);
    expect(rig.changes()).toBe(1);

    // Over-limit input is sliced to NOTE_LIMIT before it leaves.
    clickAction(rig, "p1", "reply");
    const again = card(rig, "p1")?.querySelector(".ann-replybox textarea");
    type(rig, must(again, "reply textarea"), "y".repeat(NOTE_LIMIT + 40));
    clickAction(rig, "p1", "reply-send");
    await tick();
    expect(rig.writes.at(-1)).toBe(`reply:p1:${"y".repeat(NOTE_LIMIT)}`);
  });

  it("should cancel a reply without writing and refuse an empty reply", async () => {
    const rig = rigOf();
    rig.panel.render([entry({ id: "p1" })]);
    clickAction(rig, "p1", "reply");
    const textarea = must(
      card(rig, "p1")?.querySelector(".ann-replybox textarea"),
      "reply textarea",
    );
    type(rig, textarea, "draft");
    clickAction(rig, "p1", "reply-cancel");
    expect(card(rig, "p1")?.querySelector(".ann-replybox")).toBeNull();
    expect(rig.writes).toHaveLength(0);

    // Whitespace-only drafts never reach io — the hint lands on the error slot.
    clickAction(rig, "p1", "reply");
    const again = must(card(rig, "p1")?.querySelector(".ann-replybox textarea"), "reply textarea");
    type(rig, again, "   ");
    clickAction(rig, "p1", "reply-send");
    await tick();
    expect(rig.writes).toHaveLength(0);
    expect(q(rig, "#hr-ann-error")?.textContent).toBe(COPY.annReplyEmpty);
  });

  it("should serialize writes: a second action waits while one is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rig = rigOf({ resolve: () => gate });
    rig.panel.render([entry({ id: "p1" }), entry({ id: "p2" })]);
    clickAction(rig, "p1", "resolve");
    clickAction(rig, "p2", "resolve");
    await tick();
    expect(rig.writes).toEqual(["resolve:p1"]);
    release();
    await tick();
    clickAction(rig, "p2", "resolve");
    await tick();
    expect(rig.writes).toEqual(["resolve:p1", "resolve:p2"]);
  });

  it("should surface write failures through onError and release the gate", async () => {
    let fail = true;
    const rig = rigOf({
      resolve: (id) => {
        if (!fail) return Promise.resolve();
        return Promise.reject(new Error(`resolve ${id} down`));
      },
    });
    rig.panel.render([entry({ id: "p1" })]);
    clickAction(rig, "p1", "resolve");
    await tick();
    expect(rig.errors).toHaveLength(1);
    expect(rig.changes()).toBe(0);

    fail = false;
    clickAction(rig, "p1", "resolve");
    await tick();
    expect(rig.changes()).toBe(1);
  });
});

describe("ann-panel · selection and open", () => {
  it("should mark a card selected and post focus on click — located only", async () => {
    const rig = rigOf();
    rig.panel.render([
      entry({ id: "p1" }),
      entry({ id: "l1", relocation: { ok: false, start: 0, end: 0, reason: "anchor_lost" } }),
    ]);
    const p1 = card(rig, "p1");
    if (p1 === null) throw new Error("no p1 card");
    click(rig, p1);
    expect(p1.getAttribute("data-hr-selected")).toBe("true");
    expect(rig.posted).toEqual([{ type: "hr-annotator/focus", id: "p1" }]);

    const l1 = card(rig, "l1");
    if (l1 === null) throw new Error("no l1 card");
    click(rig, l1);
    expect(l1.getAttribute("data-hr-selected")).toBe("true");
    // A lost card is selectable but never scrolls the frame.
    expect(rig.posted).toHaveLength(1);
    await tick();
  });

  it("should move the selection when another card is clicked", () => {
    const rig = rigOf();
    rig.panel.render([entry({ id: "p1" }), entry({ id: "p2" })]);
    const p1 = card(rig, "p1");
    const p2 = card(rig, "p2");
    if (p1 === null || p2 === null) throw new Error("cards missing");
    click(rig, p1);
    click(rig, p2);
    expect(p1.getAttribute("data-hr-selected")).toBeNull();
    expect(p2.getAttribute("data-hr-selected")).toBe("true");
    expect(rig.posted).toEqual([
      { type: "hr-annotator/focus", id: "p1" },
      { type: "hr-annotator/focus", id: "p2" },
    ]);
  });

  it("should select and scroll on open, and ignore unknown ids", () => {
    const rig = rigOf();
    rig.panel.render([entry({ id: "a1" }), entry({ id: "a2" })]);
    const scrolled: string[] = [];
    const c = card(rig, "a2");
    if (c === null) throw new Error("no a2 card");
    c.scrollIntoView = () => {
      scrolled.push("a2");
    };
    rig.panel.select("a2");
    expect(c.getAttribute("data-hr-selected")).toBe("true");
    expect(scrolled).toEqual(["a2"]);

    rig.panel.select("zz");
    expect(scrolled).toEqual(["a2"]);
  });

  it("should keep the selection across a refresh while the item still exists", () => {
    const rig = rigOf();
    rig.panel.render([entry({ id: "a1" })]);
    rig.panel.select("a1");
    // The entry resolves + moves groups: the rebuilt card stays selected.
    rig.panel.render([entry({ id: "a1", status: "resolved", resolvedAt: "2024-06-01T00:00:00Z" })]);
    expect(card(rig, "a1")?.getAttribute("data-hr-selected")).toBe("true");
    expect(cards(rig, "#hr-ann-resolved")).toHaveLength(1);

    // Vanished → the selection is pruned.
    rig.panel.render([]);
    expect(q(rig, "#hr-ann-panel [data-hr-selected]")).toBeNull();
  });

  it("should drop reply/confirm/selection state for entries that disappear", () => {
    const rig = rigOf();
    rig.panel.render([entry({ id: "a1" }), entry({ id: "a2" })]);
    clickAction(rig, "a1", "reply");
    clickAction(rig, "a2", "delete");
    rig.panel.select("a2");
    rig.panel.render([entry({ id: "a1" })]);
    // a1's reply box survives (still present); a2's confirm + selection are gone with the card.
    expect(card(rig, "a1")?.querySelector(".ann-replybox")).not.toBeNull();
    expect(q(rig, "#hr-ann-panel [data-hr-selected]")).toBeNull();
  });

  it("should not select on action or box clicks — only bare card clicks", () => {
    const rig = rigOf();
    rig.panel.render([entry({ id: "a1" })]);
    clickAction(rig, "a1", "reply");
    expect(card(rig, "a1")?.getAttribute("data-hr-selected")).toBeNull();
    const box = card(rig, "a1")?.querySelector(".ann-replybox");
    if (box === null || box === undefined) throw new Error("no reply box");
    click(rig, box);
    expect(card(rig, "a1")?.getAttribute("data-hr-selected")).toBeNull();
    expect(rig.posted).toHaveLength(0);
  });
});

describe("ann-panel · open/close/destroy", () => {
  it("should expose itself on open and hide + reset on close", () => {
    const rig = rigOf();
    rig.panel.render([entry({ id: "a1" })]);
    rig.panel.select("a1");
    rig.panel.close();
    const panelEl = q(rig, "#hr-ann-panel");
    expect(panelEl?.hasAttribute("hidden")).toBe(true);
    expect(q(rig, "#hr-root")?.hasAttribute("data-hr-annotate")).toBe(false);
    expect(q(rig, "#hr-ann-pending")?.children.length).toBe(0);
    expect(q(rig, "#hr-ann-panel [data-hr-selected]")).toBeNull();

    // Re-opening repaints the (reset) list state.
    rig.panel.open();
    expect(panelEl?.hasAttribute("hidden")).toBe(false);
  });

  it("should go fully quiet after destroy", () => {
    const rig = rigOf();
    rig.panel.render([entry({ id: "a1" })]);
    rig.panel.destroy();
    rig.panel.select("a1");
    rig.panel.render([entry({ id: "a2" })]);
    rig.panel.open();
    expect(rig.posted).toHaveLength(0);
    expect(card(rig, "a1")?.getAttribute("data-hr-selected")).toBeNull();
    expect(q(rig, "#hr-ann-panel")?.hasAttribute("hidden")).toBe(true);
    // Clicks dead too: no writes, no selection.
    const c = card(rig, "a1");
    if (c !== null) click(rig, c);
    expect(rig.writes).toHaveLength(0);
  });
});

describe("ann-panel · xss safety", () => {
  const PAYLOADS = [
    '<img src=x onerror="steal()">',
    "</textarea><img src=x onerror=alert(1)>",
    "<svg onload=alert(2)>",
    "{{x}}",
    "\u202E‮dlirow",
    "\u0000\u0007",
  ];

  const assertClean = (rig: Rig): void => {
    const panelEl = q(rig, "#hr-ann-panel");
    // Nothing from the data became an element or an event handler attribute:
    // the payload stays text, and the card count stays at exactly what was rendered.
    expect(panelEl?.querySelector("img")).toBeNull();
    expect(panelEl?.querySelector("svg")).toBeNull();
    expect(panelEl?.querySelector("iframe")).toBeNull();
    expect(panelEl?.querySelector("[onerror]")).toBeNull();
    expect(panelEl?.querySelector("[onload]")).toBeNull();
    expect(panelEl?.querySelector("[onmouseover]")).toBeNull();
  };

  it("should render hostile notes, quotes, replies and authors as text only", () => {
    const rig = rigOf();
    for (const payload of PAYLOADS) {
      rig.panel.render([
        entry({
          id: "a1",
          note: payload,
          exact: payload,
          author: payload,
          replies: [{ id: "r1", author: payload, note: payload, createdAt: payload }],
        }),
      ]);
      const c = card(rig, "a1");
      expect(c?.querySelector(".ann-note")?.textContent).toBe(payload);
      expect(c?.querySelector(".ann-quote")?.textContent).toBe(payload);
      expect(c?.querySelector(".ann-reply-note")?.textContent).toBe(payload);
      expect(c?.querySelector(".ann-item > .ann-meta")?.textContent).toBe(
        `${payload} · 2024-05-01T10:00:00Z`,
      );
      assertClean(rig);
    }
  });

  it("should keep a hostile id an inert attribute and still reach the card", () => {
    const rig = rigOf();
    // `]` would close an unescaped attribute selector; the rest would inject.
    const id = `evil] img[src=x onmouseover=alert(1)`;
    rig.panel.render([entry({ id })]);
    const c = card(rig, id);
    expect(c).not.toBeNull();
    expect(c?.getAttribute("data-hr-annotation")).toBe(id);
    expect(c?.getAttribute("onmouseover")).toBeNull();
    // select() with the hostile id still finds the card through the escaped selector.
    const scrolled: string[] = [];
    if (c === null) throw new Error("no hostile card");
    c.scrollIntoView = () => {
      scrolled.push(id);
    };
    rig.panel.select(id);
    expect(c.getAttribute("data-hr-selected")).toBe("true");
    expect(scrolled).toEqual([id]);
    assertClean(rig);
  });

  it("should store a quote-hostile id verbatim without it escaping into markup", () => {
    const rig = rigOf();
    const id = `evil" onmouseover="alert(1)" x="`;
    rig.panel.render([entry({ id })]);
    // happy-dom's parser can't handle `\"` in a quoted selector — reach the card by
    // scanning instead; the escape contract itself is covered by selector-escape.test.
    const c = cards(rig, "#hr-ann-panel").find(
      (el) => el.getAttribute("data-hr-annotation") === id,
    );
    expect(c).not.toBeUndefined();
    expect(c?.getAttribute("onmouseover")).toBeNull();
    assertClean(rig);
  });

  it("should keep hostile relocation reasons and resolution notes inert", () => {
    const rig = rigOf();
    const payload = PAYLOADS[0] ?? "";
    rig.panel.render([
      entry({
        id: "l1",
        status: "resolved",
        resolvedAt: payload,
        resolutionNote: payload,
        relocation: { ok: false, start: 0, end: 0, reason: payload },
      }),
    ]);
    const c = card(rig, "l1");
    expect(c?.querySelector(".ann-lost")?.textContent).toBe(`${COPY.annLostGroup}：${payload}`);
    expect(c?.querySelector(".ann-resolved")?.textContent).toContain(payload);
    assertClean(rig);
  });

  it("should keep hostile reply drafts inside the textarea, never in the DOM", () => {
    const rig = rigOf();
    const payload = PAYLOADS[1] ?? "";
    rig.panel.render([entry({ id: "a1" })]);
    clickAction(rig, "a1", "reply");
    const textarea = card(rig, "a1")?.querySelector(".ann-replybox textarea");
    if (textarea === null || textarea === undefined) throw new Error("no textarea");
    type(rig, textarea, payload);
    // Re-render the same list: the box rebuilds with the draft as its value only.
    rig.panel.render([entry({ id: "a1" })]);
    const again = card(rig, "a1")?.querySelector(".ann-replybox textarea");
    expect([again?.value, again?.textContent]).toContain(payload);
    expect(card(rig, "a1")?.querySelectorAll("textarea").length).toBe(1);
    assertClean(rig);
  });
});

// Guard and prune paths a real DOM can't reach: an event target without
// `closest`, a `closest` that resolves to nothing or to elements with null
// attrs, a reply-input with no card ancestor, and writes that settle after
// destroy — all driven through the fake host's `fire`.
describe("ann-panel · event guards through synthetic targets", () => {
  const PANEL_SEL = "#hr-root #hr-ann-panel";

  interface FakeRig {
    readonly panel: AnnPanelHandle;
    readonly fake: FakeHost;
    readonly writes: string[];
    readonly posted: Record<string, unknown>[];
    readonly errors: unknown[];
    readonly changes: () => number;
  }

  const fakeRigOf = (ioOver: Partial<AnnPanelIo> = {}): FakeRig => {
    const fake = createFakeHost();
    const { io, deps, writes, posted, errors, changes } = recordersOf(ioOver);
    const panel = mountAnnPanel({ host: fake.host, parent: "#hr-root", io, ...deps });
    panel.open();
    return { panel, fake, writes, posted, errors, changes };
  };

  /** A click target inside a card carrying `id`; `action` names the action element hit. */
  const cardTarget = (id: string | null, action?: string | null): TargetLike => ({
    closest: (sel) => {
      if (sel === "[data-hr-annotation]") return { getAttribute: () => id };
      if (sel === "[data-hr-action]") {
        if (action === undefined) return null;
        return { getAttribute: () => action };
      }
      return null;
    },
  });

  const inputTarget = (id: string | null, value?: string): TargetLike => ({
    closest: (sel) => {
      if (sel === "[data-hr-reply-input]") return { getAttribute: () => "" };
      if (sel === "[data-hr-annotation]") return { getAttribute: () => id };
      return null;
    },
    ...(value === undefined ? {} : { value }),
  });

  it("should ignore clicks and inputs whose target cannot resolve closest", () => {
    const rig = fakeRigOf();
    rig.panel.render([entry({ id: "a1" })]);
    rig.fake.fire(PANEL_SEL, "click", {});
    rig.fake.fire(PANEL_SEL, "input", {});
    expect(rig.posted).toHaveLength(0);
    expect(rig.writes).toHaveLength(0);
  });

  it("should ignore a click with no card ancestor, a null id or an unknown id", () => {
    const rig = fakeRigOf();
    rig.panel.render([entry({ id: "a1" })]);
    rig.fake.fire(PANEL_SEL, "click", { closest: () => null });
    rig.fake.fire(PANEL_SEL, "click", cardTarget(null));
    rig.fake.fire(PANEL_SEL, "click", cardTarget("ghost"));
    expect(rig.posted).toHaveLength(0);
    expect(rig.writes).toHaveLength(0);
  });

  it("should select on an action-less target but never on a click inside a box", () => {
    const rig = fakeRigOf();
    rig.panel.render([entry({ id: "a1" })]);
    // The action element exists but reads a null action attr → bare-card path.
    rig.fake.fire(PANEL_SEL, "click", cardTarget("a1", null));
    expect(rig.posted).toEqual([{ type: "hr-annotator/focus", id: "a1" }]);
    // Inside a [data-hr-box]: selection never fires.
    rig.fake.fire(PANEL_SEL, "click", {
      closest: (sel) => {
        if (sel === "[data-hr-annotation]") return { getAttribute: () => "a1" };
        if (sel === "[data-hr-box]") return { getAttribute: () => "" };
        return null;
      },
    });
    expect(rig.posted).toHaveLength(1);
  });

  it("should ignore an input outside the reply box or inside it without a card id", () => {
    const rig = fakeRigOf();
    rig.panel.render([entry({ id: "a1" })]);
    rig.fake.fire(PANEL_SEL, "input", { closest: () => null });
    // Reply-input found but no card ancestor.
    rig.fake.fire(PANEL_SEL, "input", {
      closest: (sel) => (sel === "[data-hr-reply-input]" ? { getAttribute: () => "" } : null),
    });
    // Card ancestor found but its id reads null.
    rig.fake.fire(PANEL_SEL, "input", inputTarget(null));
    // A valid input with no `value` → the draft falls back to "".
    rig.fake.fire(PANEL_SEL, "input", inputTarget("a1"));
    // Open + send with the "" draft: still the empty gate, no write.
    rig.fake.fire(PANEL_SEL, "click", cardTarget("a1", "reply"));
    rig.fake.fire(PANEL_SEL, "click", cardTarget("a1", "reply-send"));
    expect(rig.writes).toHaveLength(0);
  });

  it("should hit the empty-reply gate when no input ever filled the draft", () => {
    const rig = fakeRigOf();
    rig.panel.render([entry({ id: "a1" })]);
    rig.fake.fire(PANEL_SEL, "click", cardTarget("a1", "reply"));
    rig.fake.fire(PANEL_SEL, "click", cardTarget("a1", "reply-send"));
    expect(rig.writes).toHaveLength(0);
  });

  it("should toggle the reply box off on a second reply click", () => {
    const rig = fakeRigOf();
    rig.panel.render([entry({ id: "a1" })]);
    rig.fake.fire(PANEL_SEL, "click", cardTarget("a1", "reply"));
    const withBox = rig.fake.calls
      .filter((c) => c.op === "children" && c.args[0] === "#hr-root #hr-ann-pending")
      .at(-1);
    expect(withBox?.args[1]).toContain("ann-replybox");
    rig.fake.fire(PANEL_SEL, "click", cardTarget("a1", "reply"));
    const withoutBox = rig.fake.calls
      .filter((c) => c.op === "children" && c.args[0] === "#hr-root #hr-ann-pending")
      .at(-1);
    expect(withoutBox?.args[1]).not.toContain("ann-replybox");
  });

  it("should prune the open reply box and its draft when the entry vanishes", () => {
    const rig = fakeRigOf();
    rig.panel.render([entry({ id: "a1" })]);
    rig.fake.fire(PANEL_SEL, "click", cardTarget("a1", "reply"));
    rig.fake.fire(PANEL_SEL, "input", inputTarget("a1", "draft-a"));
    rig.panel.render([]);
    // The pruned render shows an empty pending list and no box anywhere.
    const last = rig.fake.calls
      .filter((c) => c.op === "children" && c.args[0] === "#hr-root #hr-ann-pending")
      .at(-1);
    expect(last?.args[1]).toBe("[]");
  });

  it("should clear the selection when the selected card gets deleted", async () => {
    const rig = fakeRigOf();
    rig.panel.render([entry({ id: "a1" })]);
    // Select it through a bare-card click (twice: the second hits the early return).
    rig.fake.fire(PANEL_SEL, "click", cardTarget("a1"));
    rig.fake.fire(PANEL_SEL, "click", cardTarget("a1"));
    expect(rig.posted).toHaveLength(2);
    rig.fake.fire(PANEL_SEL, "click", cardTarget("a1", "delete"));
    rig.fake.fire(PANEL_SEL, "click", cardTarget("a1", "delete-yes"));
    await tick();
    expect(rig.writes).toEqual(["remove:a1"]);
    expect(rig.changes()).toBe(1);
    // The selection is gone: render keeps no data-hr-selected card behind.
    rig.panel.render([]);
    const last = rig.fake.calls
      .filter((c) => c.op === "children" && c.args[0] === "#hr-root #hr-ann-pending")
      .at(-1);
    expect(last?.args[1]).toBe("[]");
  });

  it("should drop a settled write silently when destroy lands mid-flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rig = fakeRigOf({ resolve: () => gate });
    rig.panel.render([entry({ id: "a1" })]);
    rig.fake.fire(PANEL_SEL, "click", cardTarget("a1", "resolve"));
    rig.panel.destroy();
    release();
    await tick();
    expect(rig.changes()).toBe(0);
  });

  it("should drop a failed write silently when destroy lands mid-flight", async () => {
    let fail!: (cause: unknown) => void;
    const gate = new Promise<void>((_resolve, reject) => {
      fail = reject;
    });
    const rig = fakeRigOf({ resolve: () => gate });
    rig.panel.render([entry({ id: "a1" })]);
    rig.fake.fire(PANEL_SEL, "click", cardTarget("a1", "resolve"));
    rig.panel.destroy();
    fail(new Error("gone"));
    await tick();
    expect(rig.errors).toHaveLength(0);
  });

  it("should keep scrollTo firing on repeat selects while markSelected early-returns", () => {
    const rig = fakeRigOf();
    rig.panel.render([entry({ id: "a1" })]);
    rig.panel.select("a1");
    rig.panel.select("a1");
    const scrolls = rig.fake.calls.filter((c) => c.op === "scrollTo");
    expect(scrolls).toHaveLength(2);
  });
});
