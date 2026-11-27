// This layer owns the foreign-document annotation panel (annotate mode, D55):
// three groups (待处理 / 已解决 / 找不到位置), per-card actions (reply / resolve /
// reopen / delete-with-confirm), click → `focus` post + selection mark, and
// `open` → select + scroll-into-view. Annotate mode drives open/close and feeds
// `render` with the same sidecar list that paints the highlights.
// Security invariant: every string from the sidecar (note, reply, exact, id,
// author, timestamps, relocation reason) lands through NodeSpec `text`
// (textContent semantics) or a `data-hr-*` attribute — never `innerHTML`.

import { NOTE_LIMIT, type SidecarEntry, type SidecarReplyEntry } from "../annotate-proto.ts";
import type { Host, NodeSpec, TargetLike } from "../dom.ts";
import { escapeAttr } from "../escape-attr.ts";
import { COPY } from "./copy.ts";

/** The four sidecar write ops (main.ts implements them over io.post with CSRF). */
export interface AnnPanelIo {
  readonly resolve: (id: string) => Promise<void>;
  readonly reopen: (id: string) => Promise<void>;
  readonly reply: (id: string, note: string) => Promise<void>;
  readonly remove: (id: string) => Promise<void>;
}

interface AnnPanelDeps {
  readonly host: Host;
  readonly parent: string;
  readonly io: AnnPanelIo;
  /** `hr-annotator/focus` posts into the frame (only for located cards). */
  readonly postToFrame: (message: Readonly<Record<string, unknown>>) => void;
  /** After every settled write: re-list → highlights + this panel re-render. */
  readonly onChanged: () => void;
  /** Write failures land on the banner error slot (foreign's reportError). */
  readonly onError: (cause: unknown) => void;
}

export interface AnnPanelHandle {
  /** Annotate-mode entry: unhide + grid slot + render the last-known list. */
  readonly open: () => void;
  /** Annotate-mode exit: hide + drop all per-card UI state. */
  readonly close: () => void;
  /** The single render path: the fetched sidecar list (also prunes stale state). */
  readonly render: (items: readonly SidecarEntry[]) => void;
  /** Frame `open {id}`: mark + scroll the card into view (unknown id = no-op). */
  readonly select: (id: string) => void;
  readonly destroy: () => void;
}

/** The anchor quote is display-truncated; the full text stays on the server. */
const QUOTE_LIMIT = 60;

const quoteOf = (exact: string): string => {
  const chars = Array.from(exact);
  return chars.length <= QUOTE_LIMIT ? exact : `${chars.slice(0, QUOTE_LIMIT).join("")}…`;
};

const authorLabelOf = (author: string): string => {
  if (author === "user") return COPY.annAuthorUser;
  if (author === "agent") return COPY.annAuthorAgent;
  return author;
};

const lostCopyOf = (reason: string): string => {
  if (reason === "anchor_lost") return COPY.annLostAnchor;
  if (reason === "orphaned") return COPY.annLostOrphaned;
  if (reason === "ambiguous") return COPY.annLostAmbiguous;
  return `${COPY.annLostGroup}：${reason}`;
};

const actionBtn = (action: string, label: string): NodeSpec => ({
  tag: "button",
  attrs: { type: "button", class: "ann-btn", "data-hr-action": action },
  text: label,
});

const repliesSpec = (replies: readonly SidecarReplyEntry[]): NodeSpec => ({
  tag: "ul",
  attrs: { class: "ann-replies" },
  children: replies.map((reply) => ({
    tag: "li",
    attrs: { class: "ann-reply" },
    children: [
      { tag: "p", attrs: { class: "ann-reply-note" }, text: reply.note },
      {
        tag: "p",
        attrs: { class: "ann-meta" },
        text: `${authorLabelOf(reply.author)} · ${reply.createdAt}`,
      },
    ],
  })),
});

const resolvedSpec = (entry: SidecarEntry, resolvedAt: string): NodeSpec => ({
  tag: "p",
  attrs: { class: "ann-resolved" },
  text:
    entry.resolutionNote === undefined
      ? `${COPY.annResolved} ${resolvedAt}`
      : `${COPY.annResolved} ${resolvedAt}：${entry.resolutionNote}`,
});

const actionsSpec = (entry: SidecarEntry): NodeSpec => ({
  tag: "div",
  attrs: { class: "ann-actions" },
  children: [
    actionBtn("reply", COPY.annReply),
    entry.status === "pending"
      ? actionBtn("resolve", COPY.annResolve)
      : actionBtn("reopen", COPY.annReopen),
    actionBtn("delete", COPY.annDelete),
  ],
});

const confirmSpec = (): NodeSpec => ({
  tag: "div",
  attrs: { class: "ann-confirm", "data-hr-box": "" },
  children: [
    { tag: "span", text: COPY.annDeleteConfirm },
    actionBtn("delete-yes", COPY.annDeleteYes),
    actionBtn("delete-no", COPY.annDeleteNo),
  ],
});

const replySpec = (draft: string): NodeSpec => ({
  tag: "div",
  attrs: { class: "ann-replybox", "data-hr-box": "" },
  children: [
    {
      tag: "textarea",
      attrs: {
        class: "ann-reply-input",
        "data-hr-reply-input": "",
        rows: "3",
        maxlength: String(NOTE_LIMIT),
      },
      text: draft,
    },
    {
      tag: "div",
      attrs: { class: "ann-actions" },
      children: [
        actionBtn("reply-send", COPY.annReplySend),
        actionBtn("reply-cancel", COPY.annReplyCancel),
      ],
    },
  ],
});

export const mountAnnPanel = (deps: AnnPanelDeps): AnnPanelHandle => {
  const { host, parent } = deps;
  // Uppercase selector names: the static wiring test only accepts literals/UPPERCASE constants.
  const PANEL = `${parent} #hr-ann-panel`;
  const TITLE = `${parent} #hr-ann-title`;
  const ANN_ERROR = `${parent} #hr-ann-error`;
  const PENDING = `${parent} #hr-ann-pending`;
  const RESOLVED = `${parent} #hr-ann-resolved`;
  const LOST = `${parent} #hr-ann-lost`;
  const GROUP_LOST = `${parent} #hr-ann-group-lost`;
  const EMPTY = `${parent} #hr-ann-empty`;
  const PENDING_TITLE = `${parent} #hr-ann-pending-title`;
  const RESOLVED_TITLE = `${parent} #hr-ann-resolved-title`;
  const LOST_TITLE = `${parent} #hr-ann-lost-title`;

  let items: readonly SidecarEntry[] = [];
  let selectedId: string | undefined;
  let replyFor: string | undefined;
  let confirmId: string | undefined;
  let pending = false;
  let dead = false;
  const drafts = new Map<string, string>();

  const cardSelector = (id: string): string => `${PANEL} [data-hr-annotation="${escapeAttr(id)}"]`;

  const markSelected = (id: string): void => {
    if (selectedId === id) return;
    const prev = selectedId;
    selectedId = id;
    if (prev !== undefined) {
      host.attr(cardSelector(prev), "data-hr-selected", undefined);
    }
    host.attr(cardSelector(id), "data-hr-selected", "true");
  };

  const cardOf = (entry: SidecarEntry): NodeSpec => {
    const children: NodeSpec[] = [
      { tag: "p", attrs: { class: "ann-quote" }, text: quoteOf(entry.exact) },
      { tag: "p", attrs: { class: "ann-note" }, text: entry.note },
    ];
    if (entry.replies.length > 0) children.push(repliesSpec(entry.replies));
    if (entry.resolvedAt !== undefined) children.push(resolvedSpec(entry, entry.resolvedAt));
    if (!entry.relocation.ok) {
      children.push({
        tag: "p",
        attrs: { class: "ann-lost" },
        text: lostCopyOf(entry.relocation.reason),
      });
    }
    children.push({
      tag: "p",
      attrs: { class: "ann-meta" },
      text: `${authorLabelOf(entry.author)} · ${entry.createdAt}`,
    });
    children.push(actionsSpec(entry));
    if (confirmId === entry.id) children.push(confirmSpec());
    if (replyFor === entry.id) children.push(replySpec(drafts.get(entry.id) ?? ""));
    return {
      tag: "li",
      attrs: {
        class: "ann-item",
        "data-hr-annotation": entry.id,
        "data-hr-status": entry.status,
        ...(entry.relocation.ok ? {} : { "data-hr-lost": "" }),
        ...(selectedId === entry.id ? { "data-hr-selected": "true" } : {}),
      },
      children,
    };
  };

  const paint = (): void => {
    const pendingSpecs = items
      .filter((entry) => entry.relocation.ok && entry.status === "pending")
      .map(cardOf);
    const resolvedSpecs = items
      .filter((entry) => entry.relocation.ok && entry.status === "resolved")
      .map(cardOf);
    const lostSpecs = items.filter((entry) => !entry.relocation.ok).map(cardOf);
    host.children(PENDING, pendingSpecs);
    host.children(RESOLVED, resolvedSpecs);
    host.children(LOST, lostSpecs);
    host.attr(GROUP_LOST, "hidden", lostSpecs.length === 0 ? "" : undefined);
    host.text(EMPTY, items.length === 0 ? COPY.annPanelEmpty : "");
  };

  /** One settled write releases the gate and re-reads the world through onChanged. */
  const run = (task: () => Promise<void>): void => {
    pending = true;
    host.text(ANN_ERROR, "");
    void task().then(
      () => {
        pending = false;
        if (dead) return;
        deps.onChanged();
      },
      (cause: unknown) => {
        pending = false;
        if (dead) return;
        deps.onError(cause);
      },
    );
  };

  const sendReply = (id: string): void => {
    const note = (drafts.get(id) ?? "").slice(0, NOTE_LIMIT);
    if (note.trim() === "") {
      host.text(ANN_ERROR, COPY.annReplyEmpty);
      return;
    }
    run(async () => {
      await deps.io.reply(id, note);
      replyFor = undefined;
      drafts.delete(id);
    });
  };

  const confirmDelete = (id: string): void => {
    run(async () => {
      await deps.io.remove(id);
      confirmId = undefined;
      if (selectedId === id) selectedId = undefined;
    });
  };

  const dispatchAction = (id: string, action: string): void => {
    if (action === "reply") {
      replyFor = replyFor === id ? undefined : id;
      confirmId = undefined;
      paint();
      return;
    }
    if (action === "reply-cancel") {
      replyFor = undefined;
      drafts.delete(id);
      paint();
      return;
    }
    if (action === "delete") {
      confirmId = id;
      paint();
      return;
    }
    if (action === "delete-no") {
      confirmId = undefined;
      paint();
      return;
    }
    if (pending) return;
    if (action === "reply-send") {
      sendReply(id);
      return;
    }
    if (action === "resolve") {
      run(() => deps.io.resolve(id));
      return;
    }
    if (action === "reopen") {
      run(() => deps.io.reopen(id));
      return;
    }
    if (action === "delete-yes") {
      confirmDelete(id);
    }
  };

  /** A click outside the interactive boxes selects the card (+ focus when located). */
  const selectFromClick = (id: string): void => {
    const entry = items.find((item) => item.id === id);
    if (entry === undefined) return;
    markSelected(id);
    if (entry.relocation.ok) {
      deps.postToFrame({ type: "hr-annotator/focus", id });
    }
  };

  const onClick = (event: TargetLike): void => {
    const closest = event.closest;
    if (closest === undefined) return;
    const card = closest("[data-hr-annotation]");
    const id = card?.getAttribute("data-hr-annotation");
    if (id === null || id === undefined) return;
    const action = closest("[data-hr-action]")?.getAttribute("data-hr-action");
    if (action === null || action === undefined) {
      // A bare-card click selects (+focus when located); clicks inside the
      // reply/confirm boxes must not flip the selection.
      if (closest("[data-hr-box]") !== null) return;
      selectFromClick(id);
      return;
    }
    dispatchAction(id, action);
  };

  const onInput = (event: TargetLike): void => {
    const closest = event.closest;
    if (closest === undefined || closest("[data-hr-reply-input]") === null) return;
    const card = closest("[data-hr-annotation]");
    const id = card?.getAttribute("data-hr-annotation");
    if (id === null || id === undefined) return;
    drafts.set(id, (event.value ?? "").slice(0, NOTE_LIMIT));
  };

  host.text(TITLE, COPY.annPanelTitle);
  host.text(PENDING_TITLE, COPY.annPending);
  host.text(RESOLVED_TITLE, COPY.annResolved);
  host.text(LOST_TITLE, COPY.annLostGroup);
  const offClick = host.on(PANEL, "click", onClick);
  const offInput = host.on(PANEL, "input", onInput);

  return {
    open: () => {
      if (dead) return;
      host.attr(parent, "data-hr-annotate", "");
      host.attr(PANEL, "hidden", undefined);
      paint();
    },
    close: () => {
      items = [];
      selectedId = undefined;
      replyFor = undefined;
      confirmId = undefined;
      drafts.clear();
      pending = false;
      host.attr(parent, "data-hr-annotate", undefined);
      host.attr(PANEL, "hidden", "");
      host.text(ANN_ERROR, "");
      paint();
    },
    render: (list) => {
      if (dead) return;
      items = list;
      const ids = new Set(list.map((entry) => entry.id));
      if (selectedId !== undefined && !ids.has(selectedId)) selectedId = undefined;
      if (replyFor !== undefined && !ids.has(replyFor)) replyFor = undefined;
      if (confirmId !== undefined && !ids.has(confirmId)) confirmId = undefined;
      for (const key of drafts.keys()) {
        if (!ids.has(key)) drafts.delete(key);
      }
      paint();
    },
    select: (id) => {
      if (dead) return;
      if (!items.some((entry) => entry.id === id)) return;
      markSelected(id);
      host.scrollTo(cardSelector(id));
    },
    destroy: () => {
      dead = true;
      offClick();
      offInput();
      host.attr(parent, "data-hr-annotate", undefined);
      host.attr(PANEL, "hidden", "");
    },
  };
};
