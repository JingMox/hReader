// This layer covers the annotate wiring in `main.ts` end to end through the
// real entry: `POST /annotate` minting, the live `annotateEnvOf` message
// channel (source/origin guards, frame geometry, postMessage), the sidecar
// IO calls, and `doc.annotations` SSE refresh.

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppIo } from "../src/main.ts";
import { REQUIRED_ANCHORS } from "../src/anchors.ts";
import { fakeElement, type FakeElement } from "./support/fake-dom.ts";
import { flush, happy, install, jsonOf, load, stubs } from "./support/main-stubs.ts";

const ROOT = "#hr-root";
const FRAME = `${ROOT} #hr-foreign-frame`;
const ERROR = `${ROOT} #hr-foreign-error`;
const BTN = `${ROOT} #hr-annotate-btn`;
const POP = `${ROOT} #hr-annotate-pop`;
const DRAFT = `${ROOT} #hr-annotate-draft`;
const SAVE = `${ROOT} #hr-annotate-save`;
const VIEW = `${ROOT} #hr-annotate-view`;

const permsOff = {
  scripts: false,
  network: false,
  scriptsSource: "doc",
  networkSource: "doc",
  modes: { scripts: "per-doc", network: "per-doc" },
};
const foreignInfo = {
  revision: "r1",
  cls: "foreign",
  trust: "off",
  scripts: true,
  permissions: permsOff,
};

const installForeignDom = (): FakeElement => {
  const root = fakeElement("div");
  for (const id of REQUIRED_ANCHORS) {
    const element = id === ROOT ? root : fakeElement("div");
    stubs.doc.bySelector.set(id, element);
    if (id !== ROOT) stubs.doc.bySelector.set(`${ROOT} ${id}`, element);
  }
  return root;
};

const el = (selector: string): FakeElement | undefined => stubs.doc.bySelector.get(selector);

interface FrameWin {
  readonly posted: { message: unknown; origin: string }[];
  readonly win: object;
}

const frameWinOf = (): FrameWin => {
  const posted: { message: unknown; origin: string }[] = [];
  const win = {
    postMessage: (message: unknown, origin: string) => {
      posted.push({ message, origin });
    },
  };
  return { posted, win };
};

const SIDECAR = {
  annotations: [
    {
      id: "a1",
      status: "pending",
      note: "una nota",
      relocation: { ok: true, start: 5, end: 10 },
    },
  ],
  diagnostics: [],
};

const annotateRespond =
  (over: { readonly annotateReply?: unknown } = {}) =>
  (url: string): Response => {
    if (url.endsWith("/info")) return jsonOf(foreignInfo);
    if (url.endsWith("/annotate"))
      return jsonOf(over.annotateReply ?? { frameUrl: "/f/cap/frame?at=t1" });
    if (url.endsWith("/sidecar")) return jsonOf(SIDECAR);
    return happy(url);
  };

const send = (message: { source?: unknown; origin?: string; data?: unknown }): void => {
  for (const handler of stubs.messages) handler(message);
};

const enter = async (): Promise<FrameWin> => {
  const fw = frameWinOf();
  const frame = el(FRAME) as FakeElement & { contentWindow?: unknown };
  frame.contentWindow = fw.win;
  stubs.doc.fire(BTN, "click", {});
  await flush();
  return fw;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("main · annotate mode e2e", () => {
  it("should mint, sandbox, take messages and write the sidecar", async () => {
    install("doc.html", "http://x/", annotateRespond());
    installForeignDom();
    await load();

    const fw = await enter();
    expect(el(FRAME)?.attrs.get("sandbox")).toBe("allow-scripts");
    expect(el(FRAME)?.attrs.get("src")).toBe("/f/cap/frame?at=t1");
    expect(el(BTN)?.attrs.get("data-on")).toBe("true");

    // hello → GET sidecar → highlights posted back into the frame.
    send({ source: fw.win, origin: "null", data: { type: "hr-annotator/hello", version: 1 } });
    await flush();
    expect(stubs.fetched).toContain("/api/doc/doc.html/sidecar");
    expect(fw.posted).toEqual([
      {
        message: {
          type: "hr-annotator/highlights",
          version: 1,
          items: [{ id: "a1", start: 5, end: 10, status: "pending" }],
        },
        origin: "*",
      },
    ]);

    // selection → popover placed from frame rect + selection rect.
    (
      el(FRAME) as {
        getBoundingClientRect?: () => { x: number; y: number; width: number; height: number };
      }
    ).getBoundingClientRect = () => ({ x: 0, y: 0, width: 800, height: 600 });
    send({
      source: fw.win,
      origin: "null",
      data: {
        type: "hr-annotator/selection",
        version: 1,
        anchor: { exact: "mundo", prefix: "", suffix: "", start: 5 },
        selector: "body > p",
        rect: { x: 20, y: 50, w: 40, h: 10 },
      },
    });
    expect(el(POP)?.attrs.has("hidden")).toBe(false);
    expect(el(POP)?.attrs.get("style")).toContain("left:");

    // note + save → POST /sidecar with the wire body, then a re-list.
    stubs.doc.fire(DRAFT, "input", { value: "mi nota" });
    stubs.doc.fire(SAVE, "click", {});
    await flush();
    const bodies = stubs.requests
      .filter((r) => r.method === "POST" && r.url.endsWith("/sidecar"))
      .map((r) => JSON.parse(String(r.body)) as Record<string, unknown>);
    expect(bodies).toEqual([
      {
        anchor: { exact: "mundo", prefix: "", suffix: "", start: 5 },
        selector: "body > p",
        note: "mi nota",
      },
    ]);

    // open → read-only view of the stored note.
    send({ source: fw.win, origin: "null", data: { type: "hr-annotator/open", id: "a1" } });
    expect(el(VIEW)?.textContent).toBe("una nota");
    expect(el(VIEW)?.attrs.has("hidden")).toBe(false);

    // doc.annotations for this doc → re-list; for another doc → dropped.
    const sidecarsBefore = stubs.fetched.filter((u) => u.endsWith("/sidecar")).length;
    stubs.sources[0]?.fire("doc.annotations", JSON.stringify({ docId: "other.html" }), "1");
    stubs.sources[0]?.fire("doc.annotations", JSON.stringify({ docId: "doc.html" }), "2");
    await flush();
    expect(stubs.fetched.filter((u) => u.endsWith("/sidecar"))).toHaveLength(sidecarsBefore + 1);

    // Exit restores the permission sandbox and the doc URL.
    stubs.doc.fire(BTN, "click", {});
    expect(el(FRAME)?.attrs.get("sandbox")).toBe("");
    expect(el(FRAME)?.attrs.get("src")).toBe("/s/doc.html");
  });

  it("should drop messages with a wrong source, a non-null origin or a bad shape", async () => {
    install("doc.html", "http://x/", annotateRespond());
    installForeignDom();
    await load();
    const fw = await enter();

    send({
      source: { other: true },
      origin: "null",
      data: { type: "hr-annotator/hello", version: 1 },
    });
    send({
      source: fw.win,
      origin: "https://evil.example",
      data: { type: "hr-annotator/hello", version: 1 },
    });
    send({ source: fw.win, data: { type: "hr-annotator/hello", version: 1 } }); // origin undefined → ""
    send({ source: fw.win, origin: "null", data: { type: "hr-annotator/hello", version: 2 } });
    send({ source: fw.win, origin: "null", data: "garbage" });
    await flush();
    expect(stubs.fetched.filter((u) => u.endsWith("/sidecar"))).toHaveLength(0);
    expect(fw.posted).toHaveLength(0);
  });

  it("should survive a frame element without contentWindow or bounding rect", async () => {
    install("doc.html", "http://x/", annotateRespond());
    installForeignDom();
    await load();
    const fw = await enter();

    // No getBoundingClientRect → placement falls back to a zero frame rect.
    send({
      source: fw.win,
      origin: "null",
      data: {
        type: "hr-annotator/selection",
        version: 1,
        anchor: { exact: "x", prefix: "", suffix: "", start: 0 },
        rect: { x: 0, y: 0, w: 0, h: 0 },
      },
    });
    expect(el(POP)?.attrs.has("hidden")).toBe(false);

    // contentWindow gone → frameWindow() is null, so a null-source message is the
    // only shape that still reaches the handler; the highlight post degrades.
    (el(FRAME) as { contentWindow?: unknown }).contentWindow = null;
    send({ source: null, origin: "null", data: { type: "hr-annotator/hello", version: 1 } });
    await flush();
    expect(stubs.fetched).toContain("/api/doc/doc.html/sidecar");
    expect(fw.posted).toHaveLength(0);

    // Element itself gone → frameRect/postToFrame no-ops.
    stubs.doc.bySelector.delete("#hr-foreign-frame");
    stubs.doc.bySelector.delete(FRAME);
    send({ source: null, origin: "null", data: { type: "hr-annotator/hello", version: 1 } });
    await flush();
  });

  it("should report mint failures and bad annotate replies in the banner", async () => {
    install(
      "doc.html",
      "http://x/",
      annotateRespond({ annotateReply: { frameUrl: "https://evil/x" } }),
    );
    installForeignDom();
    await load();

    stubs.doc.fire(BTN, "click", {});
    await flush();
    expect(el(ERROR)?.textContent).toContain("annotate");
    expect(el(FRAME)?.attrs.get("sandbox")).toBe("");

    install("doc.html", "http://x/", (url) =>
      url.endsWith("/annotate") ? new Response("{}", { status: 403 }) : annotateRespond()(url),
    );
    installForeignDom();
    await load();
    stubs.doc.fire(BTN, "click", {});
    await flush();
    expect(el(ERROR)?.textContent).toContain("403");
  });

  it("should report the missing write channel when io has no post", async () => {
    install("doc.html", "http://x/", annotateRespond());
    installForeignDom();
    const { bootDocumentWith } = await import("../src/main.ts");
    const fake = (await import("./support/fake-host.ts")).createFakeHost();
    const io: AppIo = {
      text: () => Promise.resolve(""),
      json: (path, guard) => {
        const candidate: unknown = path.endsWith("/info")
          ? foreignInfo
          : path === "/api/theme"
            ? { themes: ["atelier-editorial"], default: "atelier-editorial" }
            : {};
        return guard(candidate)
          ? Promise.resolve(candidate)
          : Promise.reject(new Error(`${path} → 响应形状不符`));
      },
    };
    await bootDocumentWith({ docId: "doc.html", io, host: fake.host });
    fake.fire(BTN, "click", {});
    await flush();
    const errorTexts = fake.calls
      .filter((c) => c.op === "text" && c.args[0] === ERROR)
      .map((c) => c.args[1] ?? "");
    expect(errorTexts.at(-1)).toBe("当前 IO 未实现写请求（POST）");
  });
});
