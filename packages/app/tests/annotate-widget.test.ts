// This layer covers `widgets/annotate`: the banner toggle state machine
// (mint → sandbox before src), message intake guards (source/origin/parse),
// popover modes (edit/hint), save → POST sidecar, the D55 panel wiring
// (open → select, enter/exit → open/close, render on refresh),
// SSE/doc.changed refresh, and the destroy path. Everything is driven through
// the fake Host, so the call sequence itself is the assertion.

import { describe, expect, it } from "vitest";

import { NOTE_LIMIT, type SidecarEntry } from "../src/annotate-proto.ts";
import {
  mountAnnotate,
  type AnnPanelIo,
  type AnnotateDeps,
  type AnnotateEnv,
  type AnnotateIo,
  type IncomingMessage,
} from "../src/widgets/annotate.ts";
import { COPY } from "../src/widgets/copy.ts";
import { createFakeHost } from "./support/fake-host.ts";

const PARENT = "#hr-foreign";
const BTN = `${PARENT} #hr-annotate-btn`;
const POP = `${PARENT} #hr-annotate-pop`;
const DRAFT = `${PARENT} #hr-annotate-draft`;
const SAVE = `${PARENT} #hr-annotate-save`;
const CANCEL = `${PARENT} #hr-annotate-cancel`;
const HINT = `${PARENT} #hr-annotate-hint`;
const ANN_PANEL = `${PARENT} #hr-ann-panel`;
const ANN_PENDING = `${PARENT} #hr-ann-pending`;

const FRAME_WIN = { frame: true };

const SELECTION = {
  type: "hr-annotator/selection",
  version: 1,
  anchor: { exact: "mundo", prefix: "hola ", suffix: " tail", start: 5 },
  selector: "body > p > b",
  rect: { x: 20, y: 50, w: 40, h: 10 },
};

const PAINT_OK: SidecarEntry = {
  id: "a1",
  status: "pending",
  note: "nota uno",
  exact: "mundo",
  author: "user",
  createdAt: "2024-05-01T10:00:00Z",
  replies: [],
  relocation: { ok: true, start: 5, end: 10 },
};
const PAINT_GONE: SidecarEntry = {
  id: "a2",
  status: "resolved",
  note: "nota dos",
  exact: "otro",
  author: "user",
  createdAt: "2024-05-01T10:00:00Z",
  replies: [],
  relocation: { ok: false, start: 0, end: 0, reason: "anchor_lost" },
};

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const deferred = <T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (cause: unknown) => void;
} => {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

interface Rig {
  readonly deps: AnnotateDeps;
  readonly fake: ReturnType<typeof createFakeHost>;
  readonly posted: Record<string, unknown>[];
  readonly frameCalls: string[];
  readonly errors: unknown[];
  readonly mintCalls: () => number;
  readonly listCalls: () => number;
  readonly added: Record<string, unknown>[];
  readonly send: (data: unknown, over?: Partial<IncomingMessage>) => void;
  readonly offs: string[];
}

const rigOf = (
  over: {
    readonly mint?: () => Promise<string>;
    readonly list?: () => Promise<readonly SidecarEntry[]>;
    readonly add?: AnnotateIo["add"];
    readonly frameRect?: AnnotateEnv["frameRect"];
    /** true = mount the D55 panel with a no-op write io (card ops covered in ann-panel.test.ts). */
    readonly panel?: boolean;
  } = {},
): Rig => {
  const fake = createFakeHost();
  const posted: Record<string, unknown>[] = [];
  const frameCalls: string[] = [];
  const errors: unknown[] = [];
  const added: Record<string, unknown>[] = [];
  const offs: string[] = [];
  let mintCalls = 0;
  let listCalls = 0;
  let handler: ((message: IncomingMessage) => void) | undefined;
  const env: AnnotateEnv = {
    onMessage: (fn) => {
      handler = fn;
      return () => {
        offs.push("message");
      };
    },
    frameWindow: () => FRAME_WIN,
    postToFrame: (message) => {
      posted.push({ ...message });
    },
    frameRect: over.frameRect ?? (() => ({ x: 100, y: 50, width: 800, height: 600 })),
    viewport: () => ({ width: 1024, height: 768 }),
  };
  const io: AnnotateIo = {
    mint: () => {
      mintCalls += 1;
      return over.mint?.() ?? Promise.resolve("/f/cap/frame?at=tok");
    },
    list: () => {
      listCalls += 1;
      return over.list?.() ?? Promise.resolve([PAINT_OK, PAINT_GONE]);
    },
    add: (body) => {
      added.push(body);
      return over.add?.(body) ?? Promise.resolve();
    },
  };
  const deps: AnnotateDeps = {
    host: fake.host,
    parent: PARENT,
    io,
    env,
    frame: {
      setSandbox: (value) => {
        frameCalls.push(`sandbox:${value}`);
      },
      navigate: (src) => {
        frameCalls.push(`nav:${src}`);
      },
    },
    sandboxOff: () => "",
    docSrc: () => "/f/cap/doc.html",
    onError: (cause) => {
      errors.push(cause);
    },
    ...(over.panel === true
      ? {
          panel: {
            io: {
              resolve: () => Promise.resolve(),
              reopen: () => Promise.resolve(),
              reply: () => Promise.resolve(),
              remove: () => Promise.resolve(),
            } satisfies AnnPanelIo,
          },
        }
      : {}),
  };
  return {
    deps,
    fake,
    posted,
    frameCalls,
    errors,
    added,
    offs,
    mintCalls: () => mintCalls,
    listCalls: () => listCalls,
    send: (data, messageOver = {}) => {
      handler?.({ source: FRAME_WIN, origin: "null", data, ...messageOver });
    },
  };
};

const enterActive = async (rig: Rig): Promise<void> => {
  rig.fake.fire(BTN, "click", {});
  await tick();
};

const attrsOf = (rig: Rig, selector: string, name: string): readonly string[] =>
  rig.fake.calls
    .filter((c) => c.op === "attr" && c.args[0] === selector && c.args[1] === name)
    .map((c) => c.args[2] ?? "");

describe("annotate widget · toggle", () => {
  it("should show the button only for foreign docs and reflect the active state", async () => {
    const rig = rigOf();
    const handle = mountAnnotate(rig.deps);
    handle.repaint("foreign");
    expect(attrsOf(rig, BTN, "hidden")).toContain("<removed>");
    expect(attrsOf(rig, BTN, "data-on").at(-1)).toBe("false");
    expect(attrsOf(rig, BTN, "title").at(-1)).toBe(COPY.annotateTitle);
    expect(attrsOf(rig, BTN, "aria-pressed").at(-1)).toBe("false");

    handle.repaint("normalizable");
    expect(attrsOf(rig, BTN, "hidden").at(-1)).toBe("");

    await enterActive(rig);
    expect(attrsOf(rig, BTN, "data-on").at(-1)).toBe("true");
    expect(attrsOf(rig, BTN, "aria-pressed").at(-1)).toBe("true");
    expect(attrsOf(rig, BTN, "title").at(-1)).toBe(COPY.annotateExit);
    expect(
      rig.fake.calls.some(
        (c) => c.op === "text" && c.args[0] === BTN && c.args[1] === COPY.annotate,
      ),
    ).toBe(true);
    expect(handle.isActive()).toBe(true);
  });

  it("should set the sandbox before navigating and exit back to the doc URL", async () => {
    const rig = rigOf();
    const handle = mountAnnotate(rig.deps);
    handle.repaint("foreign");
    await enterActive(rig);
    expect(rig.frameCalls).toEqual(["sandbox:allow-scripts", "nav:/f/cap/frame?at=tok"]);

    rig.fake.fire(BTN, "click", {});
    expect(rig.frameCalls.slice(2)).toEqual(["sandbox:", "nav:/f/cap/doc.html"]);
    expect(handle.isActive()).toBe(false);
    expect(attrsOf(rig, POP, "hidden").at(-1)).toBe("");
    // The toggle repaints back to its idle face on exit.
    expect(attrsOf(rig, BTN, "data-on").at(-1)).toBe("false");
    expect(attrsOf(rig, BTN, "title").at(-1)).toBe(COPY.annotateTitle);
  });

  it("should ignore the toggle while a mint is pending and report mint failures", async () => {
    const gate = deferred<string>();
    let n = 0;
    const rig = rigOf({
      mint: () => (++n === 1 ? gate.promise : Promise.resolve("/f/cap/frame?at=t2")),
    });
    mountAnnotate(rig.deps);
    rig.fake.fire(BTN, "click", {});
    rig.fake.fire(BTN, "click", {}); // still pending → no second mint
    expect(rig.mintCalls()).toBe(1);
    gate.reject(new Error("mint denied"));
    await tick();
    expect(rig.errors).toHaveLength(1);
    expect(rig.frameCalls).toHaveLength(0);

    rig.fake.fire(BTN, "click", {});
    gate.resolve("/f/cap/frame?at=t2");
    await tick();
    expect(rig.frameCalls).toEqual(["sandbox:allow-scripts", "nav:/f/cap/frame?at=t2"]);
  });
});

describe("annotate widget · message intake", () => {
  it("should drop messages from other windows, origins or malformed payloads", async () => {
    const rig = rigOf();
    mountAnnotate(rig.deps);
    await enterActive(rig);

    rig.send({ type: "hr-annotator/hello", version: 1 }, { source: { other: true } });
    rig.send({ type: "hr-annotator/hello", version: 1 }, { origin: "https://evil.example" });
    rig.send({ type: "hr-annotator/nope", version: 1 });
    rig.send("garbage");
    expect(rig.listCalls()).toBe(0);

    rig.send({ type: "hr-annotator/hello", version: 1 });
    await tick();
    expect(rig.listCalls()).toBe(1);
  });

  it("should drop everything while inactive", async () => {
    const rig = rigOf();
    mountAnnotate(rig.deps);
    rig.send({ type: "hr-annotator/hello", version: 1 });
    await tick();
    expect(rig.listCalls()).toBe(0);
  });

  it("should post highlights for relocated entries only after hello", async () => {
    const rig = rigOf();
    mountAnnotate(rig.deps);
    await enterActive(rig);
    rig.send({ type: "hr-annotator/hello", version: 1 });
    await tick();
    expect(rig.posted).toEqual([
      {
        type: "hr-annotator/highlights",
        version: 1,
        items: [{ id: "a1", start: 5, end: 10, status: "pending" }],
      },
    ]);
  });

  it("should surface list failures through onError", async () => {
    const rig = rigOf({ list: () => Promise.reject(new Error("sidecar down")) });
    mountAnnotate(rig.deps);
    await enterActive(rig);
    rig.send({ type: "hr-annotator/hello", version: 1 });
    await tick();
    expect(rig.errors).toHaveLength(1);
  });
});

describe("annotate widget · popover", () => {
  const enterWithList = async (rig: Rig): Promise<void> => {
    mountAnnotate(rig.deps);
    await enterActive(rig);
    rig.send({ type: "hr-annotator/hello", version: 1 });
    await tick();
  };

  it("should open the editor at the selection rect and hide on cleared", async () => {
    const rig = rigOf();
    await enterWithList(rig);
    rig.send(SELECTION);
    const styles = attrsOf(rig, POP, "style");
    expect(styles.at(-1)).toBe("left:120px;top:116px");
    expect(attrsOf(rig, POP, "hidden").at(-1)).toBe("<removed>");
    expect(attrsOf(rig, DRAFT, "hidden").at(-1)).toBe("<removed>");
    expect(attrsOf(rig, HINT, "hidden").at(-1)).toBe("");

    rig.send({ type: "hr-annotator/selection-cleared" });
    expect(attrsOf(rig, POP, "hidden").at(-1)).toBe("");
  });

  it("should keep the popover on cleared while the draft has focus", async () => {
    const rig = rigOf();
    await enterWithList(rig);
    rig.send(SELECTION);
    rig.fake.fire(DRAFT, "focus", {});
    rig.send({ type: "hr-annotator/selection-cleared" });
    expect(attrsOf(rig, POP, "hidden").at(-1)).toBe("<removed>");
    rig.fake.fire(DRAFT, "blur", {});
    rig.send({ type: "hr-annotator/selection-cleared" });
    expect(attrsOf(rig, POP, "hidden").at(-1)).toBe("");
  });

  it("should show the too-long hint and the empty-note hint", async () => {
    const rig = rigOf();
    await enterWithList(rig);
    rig.send({ type: "hr-annotator/selection-too-long" });
    expect(attrsOf(rig, POP, "hidden").at(-1)).toBe("<removed>");
    expect(attrsOf(rig, HINT, "hidden").at(-1)).toBe("<removed>");
    expect(attrsOf(rig, DRAFT, "hidden").at(-1)).toBe("");
    expect(attrsOf(rig, SAVE, "hidden").at(-1)).toBe("");
    expect(attrsOf(rig, POP, "style").at(-1)).toMatch(/^left:[\d.-]+px;top:[\d.-]+px$/);
    const hintTexts = rig.fake.calls.filter((c) => c.op === "text" && c.args[0] === HINT);
    expect(hintTexts.at(-1)?.args[1]).toBe(COPY.annotateTooLong);

    rig.send(SELECTION); // back to edit
    expect(attrsOf(rig, DRAFT, "hidden").at(-1)).toBe("<removed>");
    expect(attrsOf(rig, SAVE, "hidden").at(-1)).toBe("<removed>");
    expect(attrsOf(rig, HINT, "hidden").at(-1)).toBe("");
    const hintTextsEdit = rig.fake.calls.filter((c) => c.op === "text" && c.args[0] === HINT);
    expect(hintTextsEdit.at(-1)?.args[1]).toBe("");
    const draftTexts = rig.fake.calls.filter((c) => c.op === "text" && c.args[0] === DRAFT);
    expect(draftTexts.at(-1)?.args[1]).toBe("");

    rig.fake.fire(SAVE, "click", {}); // empty draft → hint
    expect(rig.added).toHaveLength(0);
    const hintTextsAfter = rig.fake.calls.filter((c) => c.op === "text" && c.args[0] === HINT);
    expect(hintTextsAfter.at(-1)?.args[1]).toBe(COPY.annotateEmpty);
    expect(attrsOf(rig, HINT, "hidden").at(-1)).toBe("<removed>");
    expect(attrsOf(rig, DRAFT, "hidden").at(-1)).toBe("");
  });

  it("should place the hint at the zero rect when the frame has none", async () => {
    const rig = rigOf({ frameRect: () => undefined });
    await enterWithList(rig);
    rig.send({ type: "hr-annotator/selection-too-long" });
    expect(attrsOf(rig, HINT, "hidden").at(-1)).toBe("<removed>");
    expect(attrsOf(rig, POP, "style").at(-1)).toMatch(/^left:[\d.-]+px;top:[\d.-]+px$/);

    rig.send(SELECTION);
    expect(attrsOf(rig, POP, "style").at(-1)).toMatch(/^left:[\d.-]+px;top:[\d.-]+px$/);
  });

  it("should save the selection with its selector and refresh highlights", async () => {
    const rig = rigOf();
    await enterWithList(rig);
    rig.send(SELECTION);
    rig.fake.fire(DRAFT, "input", { value: "una nota" });
    rig.fake.fire(SAVE, "click", {});
    await tick();
    expect(rig.added).toEqual([
      { anchor: SELECTION.anchor, selector: SELECTION.selector, note: "una nota" },
    ]);
    expect(rig.listCalls()).toBe(2); // hello + post-save refresh
    expect(attrsOf(rig, POP, "hidden").at(-1)).toBe("");
  });

  it("should save without a selector when the frame omitted it", async () => {
    const rig = rigOf();
    await enterWithList(rig);
    const noSelector: Record<string, unknown> = { ...SELECTION };
    delete noSelector["selector"];
    rig.send(noSelector);
    rig.fake.fire(DRAFT, "input", { value: "n" });
    rig.fake.fire(SAVE, "click", {});
    await tick();
    expect(rig.added).toEqual([{ anchor: SELECTION.anchor, note: "n" }]);
    expect("selector" in (rig.added[0] ?? {})).toBe(false);
  });

  it("should cancel and escape out of the editor", async () => {
    const rig = rigOf();
    await enterWithList(rig);
    rig.send(SELECTION);
    rig.fake.fire(CANCEL, "click", {});
    expect(attrsOf(rig, POP, "hidden").at(-1)).toBe("");
    expect(rig.added).toHaveLength(0);

    rig.send(SELECTION);
    rig.fake.fire(POP, "keydown", { key: "x" });
    expect(attrsOf(rig, POP, "hidden").at(-1)).toBe("<removed>");
    rig.fake.fire(POP, "keydown", { key: "Escape" });
    expect(attrsOf(rig, POP, "hidden").at(-1)).toBe("");
  });

  it("should slice the draft at NOTE_LIMIT", async () => {
    const rig = rigOf();
    await enterWithList(rig);
    rig.send(SELECTION);
    rig.fake.fire(DRAFT, "input", { value: "x".repeat(NOTE_LIMIT + 50) });
    rig.fake.fire(SAVE, "click", {});
    await tick();
    expect((rig.added[0]?.["note"] as string).length).toBe(NOTE_LIMIT);
  });

  it("should treat a whitespace-only note as empty and a missing value as empty", async () => {
    const rig = rigOf();
    await enterWithList(rig);
    rig.send(SELECTION);
    rig.fake.fire(DRAFT, "input", { value: "   " });
    rig.fake.fire(SAVE, "click", {});
    expect(rig.added).toHaveLength(0);

    rig.send(SELECTION);
    rig.fake.fire(DRAFT, "input", {}); // target.value undefined → ""
    rig.fake.fire(SAVE, "click", {});
    expect(rig.added).toHaveLength(0);
  });

  it("should select the panel card on open and ignore unknown ids", async () => {
    const rig = rigOf({ panel: true });
    await enterWithList(rig);
    rig.send({ type: "hr-annotator/open", id: "a1" });
    expect(attrsOf(rig, `${ANN_PANEL} [data-hr-annotation="a1"]`, "data-hr-selected").at(-1)).toBe(
      "true",
    );
    const scrolls = rig.fake.calls.filter((c) => c.op === "scrollTo");
    expect(scrolls.at(-1)?.args[0]).toBe(`${ANN_PANEL} [data-hr-annotation="a1"]`);
    // `open` no longer opens the popover — selection lives in the panel.
    expect(attrsOf(rig, POP, "hidden")).not.toContain("<removed>");

    const before = rig.fake.calls.length;
    rig.send({ type: "hr-annotator/open", id: "zz" });
    expect(rig.fake.calls.length).toBe(before);
  });

  it("should ignore open for entries dropped by a refresh", async () => {
    let items: readonly SidecarEntry[] = [PAINT_OK];
    const rig = rigOf({ list: () => Promise.resolve(items), panel: true });
    const handle = mountAnnotate(rig.deps);
    await enterActive(rig);
    rig.send({ type: "hr-annotator/hello", version: 1 });
    await tick();
    rig.send({ type: "hr-annotator/open", id: "a1" });
    expect(attrsOf(rig, `${ANN_PANEL} [data-hr-annotation="a1"]`, "data-hr-selected").at(-1)).toBe(
      "true",
    );

    items = [];
    handle.annotationsChanged();
    await tick();
    const before = rig.fake.calls.length;
    rig.send({ type: "hr-annotator/open", id: "a1" });
    expect(rig.fake.calls.length).toBe(before);
  });

  it("should do nothing on open when no panel is mounted", async () => {
    const rig = rigOf();
    await enterWithList(rig);
    const before = rig.fake.calls.length;
    rig.send({ type: "hr-annotator/open", id: "a1" });
    expect(rig.fake.calls.length).toBe(before);
  });

  it("should report save failures and stay in edit mode", async () => {
    const rig = rigOf({ add: () => Promise.reject(new Error("post failed")) });
    await enterWithList(rig);
    rig.send(SELECTION);
    rig.fake.fire(DRAFT, "input", { value: "n" });
    rig.fake.fire(SAVE, "click", {});
    await tick();
    expect(rig.errors).toHaveLength(1);
    expect(attrsOf(rig, POP, "hidden").at(-1)).toBe("<removed>");
    // A failed save releases the pending flag: the next click POSTs again.
    rig.fake.fire(SAVE, "click", {});
    await tick();
    expect(rig.added).toHaveLength(2);
    expect(rig.errors).toHaveLength(2);
  });

  it("should not double-save while a save is in flight", async () => {
    const gate = deferred<undefined>();
    const rig = rigOf({ add: () => gate.promise });
    await enterWithList(rig);
    rig.send(SELECTION);
    rig.fake.fire(DRAFT, "input", { value: "n" });
    rig.fake.fire(SAVE, "click", {});
    rig.fake.fire(SAVE, "click", {});
    expect(rig.added).toHaveLength(1);
    gate.resolve(undefined);
    await tick();
  });

  it("should ignore save clicks without a pending selection", async () => {
    const rig = rigOf();
    await enterWithList(rig);
    rig.fake.fire(SAVE, "click", {}); // no selection yet
    // A typed draft without a selection still cannot save — and must not throw.
    rig.fake.fire(DRAFT, "input", { value: "x" });
    rig.fake.fire(SAVE, "click", {});
    await tick();
    expect(rig.added).toHaveLength(0);
  });
});

describe("annotate widget · panel lifecycle", () => {
  it("should open the panel on enter, render lists on hello and close on exit", async () => {
    const rig = rigOf({ panel: true });
    mountAnnotate(rig.deps);
    await enterActive(rig);
    expect(attrsOf(rig, PARENT, "data-hr-annotate").at(-1)).toBe("");
    expect(attrsOf(rig, ANN_PANEL, "hidden").at(-1)).toBe("<removed>");

    rig.send({ type: "hr-annotator/hello", version: 1 });
    await tick();
    const childCalls = rig.fake.calls.filter((c) => c.op === "children");
    expect(childCalls.some((c) => c.args[0] === ANN_PENDING)).toBe(true);
    expect(childCalls.some((c) => c.args[0] === `${PARENT} #hr-ann-resolved`)).toBe(true);
    expect(childCalls.some((c) => c.args[0] === `${PARENT} #hr-ann-lost`)).toBe(true);

    rig.fake.fire(BTN, "click", {});
    expect(attrsOf(rig, PARENT, "data-hr-annotate").at(-1)).toBe("<removed>");
    expect(attrsOf(rig, ANN_PANEL, "hidden").at(-1)).toBe("");
  });

  it("should not touch the panel when no panel dep is given", async () => {
    const rig = rigOf();
    mountAnnotate(rig.deps);
    await enterActive(rig);
    expect(rig.fake.calls.some((c) => String(c.args[0]).includes("hr-ann-panel"))).toBe(false);
  });
});

describe("annotate widget · refresh and destroy", () => {
  it("should re-mint on doc.changed and navigate only when still active", async () => {
    const rig = rigOf();
    const handle = mountAnnotate(rig.deps);
    await enterActive(rig);
    handle.refresh();
    await tick();
    expect(rig.mintCalls()).toBe(2);
    expect(rig.frameCalls.at(-1)).toBe("nav:/f/cap/frame?at=tok");
    // refresh does not re-set the sandbox (still allow-scripts).
    expect(rig.frameCalls.filter((c) => c.startsWith("sandbox"))).toHaveLength(1);

    handle.refresh(); // exits before mint resolves? no — mint is instant; exit first
    rig.fake.fire(BTN, "click", {}); // exit now
    handle.refresh();
    await tick();
    expect(rig.mintCalls()).toBe(3); // only the second call above
  });

  it("should exit annotate mode and report when a re-mint fails", async () => {
    const gate = deferred<string>();
    let calls = 0;
    const rig = rigOf({
      mint: () => {
        calls += 1;
        return calls === 1 ? Promise.resolve("/f/cap/frame?at=t1") : gate.promise;
      },
    });
    const handle = mountAnnotate(rig.deps);
    handle.repaint("foreign");
    await enterActive(rig);
    handle.refresh();
    gate.reject(new Error("expired"));
    await tick();
    expect(handle.isActive()).toBe(false);
    expect(rig.errors).toHaveLength(1);
    expect(rig.frameCalls.at(-1)).toBe("nav:/f/cap/doc.html");
  });

  it("should not navigate after destroy wins the race with mint", async () => {
    const gate = deferred<string>();
    const rig = rigOf({ mint: () => gate.promise });
    const handle = mountAnnotate(rig.deps);
    handle.repaint("foreign");
    handle.refresh(); // inactive → no mint
    rig.fake.fire(BTN, "click", {}); // enter: pending mint
    handle.destroy();
    gate.resolve("/f/cap/frame?at=late");
    await tick();
    expect(rig.frameCalls).toHaveLength(0);
    expect(rig.offs).toContain("message");
    expect(attrsOf(rig, BTN, "hidden").at(-1)).toBe("");
    expect(attrsOf(rig, POP, "hidden").at(-1)).toBe("");
    // A message after destroy must be a no-op.
    rig.send({ type: "hr-annotator/hello", version: 1 });
    await tick();
    expect(rig.listCalls()).toBe(0);
  });

  it("should unbind every control on destroy", async () => {
    const rig = rigOf();
    const handle = mountAnnotate(rig.deps);
    await enterActive(rig);
    rig.send({ type: "hr-annotator/hello", version: 1 });
    await tick();
    rig.send(SELECTION);
    handle.destroy();
    const callsBefore = rig.fake.calls.length;
    rig.fake.fire(BTN, "click", {});
    rig.fake.fire(SAVE, "click", {});
    rig.fake.fire(CANCEL, "click", {});
    rig.fake.fire(POP, "keydown", { key: "Escape" });
    await tick();
    expect(rig.mintCalls()).toBe(1);
    expect(rig.added).toHaveLength(0);
    expect(rig.fake.calls.length).toBe(callsBefore);
  });

  it("should drop a mint that resolves after exit", async () => {
    const gate = deferred<string>();
    let n = 0;
    const rig = rigOf({
      mint: () => (++n === 1 ? Promise.resolve("/f/cap/frame?at=t1") : gate.promise),
    });
    const handle = mountAnnotate(rig.deps);
    handle.repaint("foreign");
    await enterActive(rig);
    handle.refresh();
    rig.fake.fire(BTN, "click", {}); // exit while the re-mint is pending
    gate.resolve("/f/cap/frame?at=stale");
    await tick();
    expect(rig.frameCalls.at(-1)).toBe("nav:/f/cap/doc.html");
  });

  it("should refresh highlights on annotationsChanged only while active", async () => {
    const rig = rigOf();
    const handle = mountAnnotate(rig.deps);
    handle.annotationsChanged(); // inactive → no list
    await tick();
    expect(rig.listCalls()).toBe(0);

    await enterActive(rig);
    handle.annotationsChanged();
    await tick();
    expect(rig.listCalls()).toBe(1);
    expect(rig.posted.at(-1)?.["type"]).toBe("hr-annotator/highlights");

    handle.destroy();
    handle.annotationsChanged();
    handle.refresh();
    await tick();
    expect(rig.listCalls()).toBe(1);
    expect(rig.mintCalls()).toBe(1);
  });

  it("should swallow a mint rejection landing after destroy", async () => {
    const gate = deferred<string>();
    const rig = rigOf({ mint: () => gate.promise });
    const handle = mountAnnotate(rig.deps);
    handle.repaint("foreign");
    rig.fake.fire(BTN, "click", {});
    handle.destroy();
    gate.reject(new Error("late"));
    await tick();
    expect(rig.errors).toHaveLength(0);
  });

  it("should swallow a save settling after destroy, resolved or rejected", async () => {
    const gate = deferred<undefined>();
    const rig = rigOf({ add: () => gate.promise });
    const handle = mountAnnotate(rig.deps);
    await enterActive(rig);
    rig.send({ type: "hr-annotator/hello", version: 1 });
    rig.send(SELECTION);
    rig.fake.fire(DRAFT, "input", { value: "n" });
    rig.fake.fire(SAVE, "click", {});
    handle.destroy();
    gate.resolve(undefined);
    await tick();
    expect(rig.errors).toHaveLength(0);
    // The resolved-arm dead check skips hidePop + the highlights re-list.
    expect(rig.listCalls()).toBe(1);

    const fail = deferred<undefined>();
    const rig2 = rigOf({ add: () => fail.promise });
    const handle2 = mountAnnotate(rig2.deps);
    await enterActive(rig2);
    rig2.send({ type: "hr-annotator/hello", version: 1 });
    rig2.send(SELECTION);
    rig2.fake.fire(DRAFT, "input", { value: "n" });
    rig2.fake.fire(SAVE, "click", {});
    handle2.destroy();
    fail.reject(new Error("late"));
    await tick();
    expect(rig2.errors).toHaveLength(0);
  });

  it("should swallow a re-mint rejection landing after destroy", async () => {
    const gate = deferred<string>();
    let n = 0;
    const rig = rigOf({
      mint: () => (++n === 1 ? Promise.resolve("/f/cap/frame?at=t1") : gate.promise),
    });
    const handle = mountAnnotate(rig.deps);
    handle.repaint("foreign");
    await enterActive(rig);
    handle.refresh();
    handle.destroy();
    gate.reject(new Error("late"));
    await tick();
    expect(rig.errors).toHaveLength(0);
  });

  it("should swallow late completions after destroy", async () => {
    const gate = deferred<readonly (typeof PAINT_OK)[]>();
    const rig = rigOf({ list: () => gate.promise });
    const handle = mountAnnotate(rig.deps);
    await enterActive(rig);
    rig.send({ type: "hr-annotator/hello", version: 1 });
    handle.destroy();
    gate.resolve([PAINT_OK]);
    await tick();
    expect(rig.posted).toHaveLength(0);

    const failGate = deferred<readonly (typeof PAINT_OK)[]>();
    const rig2 = rigOf({ list: () => failGate.promise });
    const handle2 = mountAnnotate(rig2.deps);
    await enterActive(rig2);
    rig2.send({ type: "hr-annotator/hello", version: 1 });
    handle2.destroy();
    failGate.reject(new Error("late"));
    await tick();
    expect(rig2.errors).toHaveLength(0);
  });
});
