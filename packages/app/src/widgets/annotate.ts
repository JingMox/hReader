// This layer owns foreign-document annotate mode: the banner toggle (mint token →
// sandbox before src), selection messages → popover, save → POST sidecar,
// `open`/SSE → highlight repaint.
// Security invariant: a message is only handled when source === frame.contentWindow
// AND origin === "null" AND it passes parseFrameMessage's strict validation; every
// other message is silently dropped (no network, no UI).

import {
  NOTE_LIMIT,
  parseFrameMessage,
  placementOf,
  type SidecarEntry,
  type WireAnchor,
} from "../annotate-proto.ts";
import type { Host } from "../dom.ts";
import { mountAnnPanel, type AnnPanelHandle, type AnnPanelIo } from "./ann-panel.ts";
import { COPY } from "./copy.ts";

export type { AnnPanelIo } from "./ann-panel.ts";

/** Wraps `POST /annotate` and `GET/POST /sidecar` (main.ts implements it over io.post/io.json). */
export interface AnnotateIo {
  readonly mint: () => Promise<string>;
  readonly list: () => Promise<readonly SidecarEntry[]>;
  readonly add: (body: {
    readonly anchor: WireAnchor;
    readonly selector?: string;
    readonly note: string;
  }) => Promise<void>;
}

/** The minimal face of a browser `message` event (nothing read beyond source/origin/data). */
export interface IncomingMessage {
  readonly source?: unknown;
  readonly origin?: string;
  readonly data?: unknown;
}

/** Real DOM injected by main.ts: contentWindow/getBoundingClientRect never pass through Host (they are not write points). */
export interface AnnotateEnv {
  readonly onMessage: (handler: (message: IncomingMessage) => void) => () => void;
  readonly frameWindow: () => unknown;
  readonly postToFrame: (message: Readonly<Record<string, unknown>>) => void;
  readonly frameRect: () =>
    | { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
    | undefined;
  readonly viewport: () => { readonly width: number; readonly height: number };
}

/** Provided by foreign.ts: the sandbox attribute write point and bookkeeping frame navigation. */
export interface AnnotateFrame {
  readonly setSandbox: (value: string) => void;
  readonly navigate: (src: string) => void;
}

export interface AnnotateDeps {
  readonly host: Host;
  readonly parent: string;
  readonly io: AnnotateIo;
  readonly env: AnnotateEnv;
  readonly frame: AnnotateFrame;
  /** The sandbox to restore on annotate-mode exit (the permission-derived value). */
  readonly sandboxOff: () => string;
  /** The normal frame URL to restore on annotate-mode exit. */
  readonly docSrc: () => string;
  /** mint/list/add failures land on the banner error slot (foreign's reportError). */
  readonly onError: (cause: unknown) => void;
  /**
   * The D55 side panel's write ops; absent = no panel (legacy shells/tests).
   * When present, the panel opens/closes with annotate mode and `open` selects there.
   */
  readonly panel?: { readonly io: AnnPanelIo } | undefined;
}

interface AnnotateHandle {
  readonly isActive: () => boolean;
  /** Piggybacked on foreign's banner repaint: button visibility (foreign only) + active state. */
  readonly repaint: (cls: "foreign" | "normalizable") => void;
  /** `doc.changed`: in annotate mode re-mint the token and reload; mint failure exits the mode and reports. */
  readonly refresh: () => void;
  /** `doc.annotations` (SSE, this doc): re-fetch the list and repaint highlights. */
  readonly annotationsChanged: () => void;
  /**
   * Focus one sidecar annotation (D61 search hit): enters annotate mode when needed,
   * then selects the card once the next list render lands.
   */
  readonly focusAnnotation: (id: string) => void;
  readonly destroy: () => void;
}

type Mode = "edit" | "hint";

export const mountAnnotate = (deps: AnnotateDeps): AnnotateHandle => {
  const { host, parent, env } = deps;
  // Uppercase selector names: the static wiring test only accepts literals/UPPERCASE constants (same convention as foreign.ts).
  const BTN = `${parent} #hr-annotate-btn`;
  const POP = `${parent} #hr-annotate-pop`;
  const DRAFT = `${parent} #hr-annotate-draft`;
  const SAVE = `${parent} #hr-annotate-save`;
  const CANCEL = `${parent} #hr-annotate-cancel`;
  const HINT = `${parent} #hr-annotate-hint`;

  let active = false;
  let pending = false;
  let dead = false;
  let mode: Mode = "edit";
  let draft = "";
  let draftFocused = false;
  let lastCls: "foreign" | "normalizable" = "foreign";
  let pendingSelection: { readonly anchor: WireAnchor; readonly selector?: string } | undefined;
  /** A `focusAnnotation` request waiting for the next list render (mint in flight / just entered). */
  let pendingSelect: string | undefined;

  const postHighlights = (items: readonly SidecarEntry[]): void => {
    const out: { id: string; start: number; end: number; status: string }[] = [];
    for (const item of items) {
      if (!item.relocation.ok) continue;
      out.push({
        id: item.id,
        start: item.relocation.start,
        end: item.relocation.end,
        status: item.status,
      });
    }
    env.postToFrame({ type: "hr-annotator/highlights", version: 1, items: out });
  };

  const refreshHighlights = (): void => {
    void deps.io.list().then(
      (items) => {
        if (dead || !active) return;
        postHighlights(items);
        panel?.render(items);
        // A focusAnnotation call parked here until this render: select now, one-shot.
        const wanted = pendingSelect;
        pendingSelect = undefined;
        if (wanted !== undefined) panel?.select(wanted);
      },
      (cause: unknown) => {
        if (dead) return;
        deps.onError(cause);
      },
    );
  };

  // The D55 side panel: the same list feeds highlights (above) and the card render;
  // its writes re-list through refreshHighlights so both stay in step. `panel` is a
  // const: refreshHighlights above captures the binding and only runs post-mount.
  const panel: AnnPanelHandle | undefined =
    deps.panel === undefined
      ? undefined
      : mountAnnPanel({
          host,
          parent,
          io: deps.panel.io,
          postToFrame: env.postToFrame,
          onChanged: refreshHighlights,
          onError: deps.onError,
        });

  const hidePop = (): void => {
    host.attr(POP, "hidden", "");
  };

  const paintMode = (): void => {
    host.attr(DRAFT, "hidden", mode === "edit" ? undefined : "");
    host.attr(SAVE, "hidden", mode === "edit" ? undefined : "");
    host.attr(HINT, "hidden", mode === "hint" ? undefined : "");
  };

  const paint = (): void => {
    host.attr(BTN, "hidden", lastCls === "foreign" ? undefined : "");
    host.text(BTN, COPY.annotate);
    host.attr(BTN, "data-on", active ? "true" : "false");
    host.attr(BTN, "aria-pressed", active ? "true" : "false");
    host.attr(BTN, "title", active ? COPY.annotateExit : COPY.annotateTitle);
    paintMode();
  };

  const showAt = (x: number, y: number): void => {
    host.attr(POP, "style", `left:${String(x)}px;top:${String(y)}px`);
    host.attr(POP, "hidden", undefined);
  };

  const showEdit = (rect: {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
  }): void => {
    const frame = env.frameRect() ?? { x: 0, y: 0, width: 0, height: 0 };
    const spot = placementOf({ x: frame.x, y: frame.y }, rect, env.viewport());
    mode = "edit";
    host.text(HINT, "");
    host.text(DRAFT, draft);
    paintMode();
    showAt(spot.x, spot.y);
  };

  const showHint = (text: string): void => {
    const frame = env.frameRect() ?? { x: 0, y: 0, width: 0, height: 0 };
    const spot = placementOf(
      { x: frame.x, y: frame.y },
      { x: 16, y: 16, w: 0, h: 0 },
      env.viewport(),
    );
    mode = "hint";
    host.text(HINT, text);
    paintMode();
    showAt(spot.x, spot.y);
  };

  const enter = (): void => {
    pending = true;
    void deps.io.mint().then(
      (url) => {
        pending = false;
        if (dead) return;
        // Sandbox must be written before src: the navigation commit samples the sandbox flags at that moment.
        deps.frame.setSandbox("allow-scripts");
        deps.frame.navigate(url);
        active = true;
        panel?.open();
        paint();
      },
      (cause: unknown) => {
        pending = false;
        if (dead) return;
        deps.onError(cause);
      },
    );
  };

  const exit = (): void => {
    active = false;
    pendingSelection = undefined;
    panel?.close();
    hidePop();
    deps.frame.setSandbox(deps.sandboxOff());
    deps.frame.navigate(deps.docSrc());
    paint();
  };

  const save = (): void => {
    if (pending || mode !== "edit" || pendingSelection === undefined) return;
    const note = draft.slice(0, NOTE_LIMIT);
    if (note.trim() === "") {
      mode = "hint";
      host.text(HINT, COPY.annotateEmpty);
      paintMode();
      return;
    }
    pending = true;
    const body: { anchor: WireAnchor; selector?: string; note: string } = {
      anchor: pendingSelection.anchor,
      note,
    };
    if (pendingSelection.selector !== undefined) body.selector = pendingSelection.selector;
    void deps.io.add(body).then(
      () => {
        pending = false;
        if (dead) return;
        pendingSelection = undefined;
        draft = "";
        hidePop();
        refreshHighlights();
      },
      (cause: unknown) => {
        pending = false;
        if (dead) return;
        deps.onError(cause);
      },
    );
  };

  const onMessage = (raw: IncomingMessage): void => {
    if (dead || !active) return;
    if (raw.source !== env.frameWindow()) return;
    if (raw.origin !== "null") return;
    const message = parseFrameMessage(raw.data);
    if (message === undefined) return;
    if (message.kind === "hello") {
      refreshHighlights();
      return;
    }
    if (message.kind === "selection") {
      pendingSelection =
        message.selector === undefined
          ? { anchor: message.anchor }
          : { anchor: message.anchor, selector: message.selector };
      draft = "";
      showEdit(message.rect);
      return;
    }
    if (message.kind === "cleared") {
      if (!draftFocused) {
        pendingSelection = undefined;
        hidePop();
      }
      return;
    }
    if (message.kind === "tooLong") {
      showHint(COPY.annotateTooLong);
      return;
    }
    // kind === "open": a highlight click selects the card in the panel.
    panel?.select(message.id);
  };

  const offMessage = env.onMessage(onMessage);
  const offBtn = host.on(BTN, "click", () => {
    if (pending) return;
    if (active) exit();
    else enter();
  });
  const offSave = host.on(SAVE, "click", save);
  const offCancel = host.on(CANCEL, "click", () => {
    pendingSelection = undefined;
    draft = "";
    hidePop();
  });
  const offDraft = host.on(DRAFT, "input", (target) => {
    draft = (target.value ?? "").slice(0, NOTE_LIMIT);
  });
  const offFocus = host.on(DRAFT, "focus", () => {
    draftFocused = true;
  });
  const offBlur = host.on(DRAFT, "blur", () => {
    draftFocused = false;
  });
  const offKey = host.on(POP, "keydown", (target) => {
    if (target.key !== "Escape") return;
    pendingSelection = undefined;
    draft = "";
    hidePop();
  });

  return {
    isActive: () => active,
    repaint: (cls) => {
      lastCls = cls;
      paint();
    },
    refresh: () => {
      if (dead || !active) return;
      void deps.io.mint().then(
        (url) => {
          if (dead || !active) return;
          deps.frame.navigate(url);
        },
        (cause: unknown) => {
          if (dead) return;
          exit();
          deps.onError(cause);
        },
      );
    },
    annotationsChanged: () => {
      if (dead || !active) return;
      refreshHighlights();
    },
    focusAnnotation: (id) => {
      if (dead) return;
      pendingSelect = id;
      // Already live: the re-list lands the select; inactive: enter() mints first
      // (hello → refreshHighlights → render → select); a mint in flight merges both waits.
      if (active) {
        refreshHighlights();
      } else if (!pending) {
        enter();
      }
    },
    destroy: () => {
      dead = true;
      offMessage();
      offBtn();
      offSave();
      offCancel();
      offDraft();
      offFocus();
      offBlur();
      offKey();
      panel?.destroy();
      hidePop();
      host.attr(BTN, "hidden", "");
    },
  };
};
