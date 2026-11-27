// F3b2 reader-side annotate journey, end-to-end in real Chrome against a real
// `hr serve`: annotate toggle → single-use annotate frame (annotator runs, page
// scripts stay dead under scripts-off) → a REAL mouse drag selects text → the
// popover opens → the note saves to the on-disk sidecar → the annotation
// returns through GET /sidecar → the frame paints it via CSS.highlights → a
// click on the highlight opens the read-only note → exit restores the
// permission sandbox and drops the annotator. Then the adversarial half:
// forged/malformed/oversized messages are dropped, a scripts-ON page forging
// `hr-annotator/selection` can only open its own popover (accepted risk D13),
// the annotator ignores non-parent sources, and pre-poisoned globals degrade
// the engine without a crash. Server-side token/CSP invariants live in
// annotate-mode.test.ts; API shapes live in sidecar-annotations.test.ts.
//
// Requires real Chrome (puppeteer-core); the whole suite skips without it.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, test } from "vitest";

import { parseHtml } from "@hreader/core";

import { assert, assertEq } from "../harness/check.ts";
import { docPath } from "../harness/cli.ts";
import { launchBrowser, type Browser, type Page } from "../harness/chrome.ts";
import { chromeSkipReason, sandbox, until, type TestHome } from "../harness/env.ts";
import { connect, docApi, type Api } from "../harness/http.ts";
import { killAllTracked } from "../harness/proc.ts";
import { startServe, type Daemon } from "../harness/serve.ts";
import { bodyTextOf } from "../../../packages/core/src/annotations/body-text.ts";

const skip = chromeSkipReason();

const DOC = "journey.html";
const FORGER_DOC = "forger.html";
const POISON_DOC = "poison.html";
const POISON_SOFT_DOC = "poison-soft.html";
const FRAME = "#hr-foreign-frame";
const ANNOTATE_TAG = "/f/";

// A scripts-bearing foreign document: no <article> keeps cls=foreign (one
// article would classify normalizable, where the annotate button stays hidden).
// The marker script is the only observable channel across the opaque origin.
const JOURNEY_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>annotate journey</title></head>
<body>
<main id="main">
<h1>Annotate journey</h1>
<p id="p1">Alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo.</p>
<p id="p2">第二段 Lima mike november oscar papa quebec romeo sierra tango.</p>
</main>
<script>parent.postMessage('page-ran','*');</script>
</body></html>`;

// A second window for the forged-message case: served same-origin, scripts
// granted — its postMessage reaches the reader with a real (non-"null") origin
// and a source that is NOT the annotate frame. Two independent drop grounds.
const FORGER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>forger</title></head>
<body>
<script>parent.postMessage({type:'hr-annotator/selection',version:1,anchor:{exact:'Alpha',prefix:'',suffix:' ',start:0},rect:{x:1,y:1,w:9,h:9}},'*');</script>
</body></html>`;

// Hard poison: the inline script runs BEFORE the deferred annotator, replacing
// the globals the annotator is about to capture. Named-access elements probe
// `window.parent`/`window.postMessage` shadowing (real properties can't be
// shadowed — that is the point of the probe).
const POISON_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>poison</title></head>
<body>
<script>
window.getSelection = "poisoned";
window.CSS = { highlights: "nope" };
window.Range = undefined;
window.Highlight = undefined;
window.requestAnimationFrame = "poisoned";
Array.prototype.map = function () { throw new Error("map-poisoned"); };
var sink = document.createElement("iframe"); sink.name = "postMessage"; document.body.appendChild(sink);
var fake = document.createElement("div"); fake.id = "parent"; document.body.appendChild(fake);
parent.postMessage('poison-installed','*');
</script>
<p id="p1">Poisoned paragraph with enough text to drag a selection across.</p>
</body></html>`;

// Soft poison: Array.prototype.map + CSS.highlights die but the selection path
// must keep working end to end.
const POISON_SOFT_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>poison soft</title></head>
<body>
<script>
window.CSS = { highlights: "nope" };
Array.prototype.map = function () { throw new Error("map-poisoned"); };
parent.postMessage('poison-installed','*');
</script>
<p id="p1">Soft-poisoned paragraph with enough text to drag across.</p>
</body></html>`;

interface WireAnchor {
  readonly exact: string;
  readonly prefix: string;
  readonly suffix: string;
  readonly start: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(skip !== undefined)("annotate-journey", () => {
  let home: TestHome;
  let daemon: Daemon;
  let api: Api;
  let browser: Browser;
  let page: Page;
  let savedAnchor: WireAnchor | undefined;
  let savedNote = "";

  /** The reader-page collector: every postMessage payload the page sees. */
  const installProbe = async (): Promise<void> => {
    await page.eval(`(() => {
      window.__pp = [];
      window.addEventListener('message', (e) => { window.__pp.push(e.data); });
      return true;
    })()`);
  };

  const msgs = async (): Promise<unknown[]> => {
    const value: unknown = await page.eval(`Array.isArray(window.__pp) ? window.__pp : []`);
    return Array.isArray(value) ? (value as unknown[]) : [];
  };

  const typed = async (type: string): Promise<unknown[]> =>
    (await msgs()).filter(
      (m) => typeof m === "object" && m !== null && Reflect.get(m, "type") === type,
    );

  const markers = async (): Promise<string[]> =>
    (await msgs()).filter((m): m is string => typeof m === "string");

  const waitTyped = async (type: string, expected: number): Promise<void> => {
    const ok = await page.wait(
      `Array.isArray(window.__pp) && window.__pp.filter((m) => m && m.type === ${JSON.stringify(type)}).length >= ${String(expected)}`,
      20_000,
    );
    assert(ok === true, `expected ${String(expected)} "${type}" messages`);
  };

  const frameAttr = async (name: string): Promise<unknown> =>
    await page.eval(
      `(() => { const f = document.querySelector(${JSON.stringify(FRAME)}); return f ? f.getAttribute(${JSON.stringify(name)}) : "no-frame"; })()`,
    );

  const frameRect = async (): Promise<{ x: number; y: number }> => {
    const rect = await page.eval(
      `(() => { const f = document.querySelector(${JSON.stringify(FRAME)}); const r = f.getBoundingClientRect(); return { x: r.x, y: r.y }; })()`,
    );
    assert(typeof rect === "object" && rect !== null, `no frame rect: ${JSON.stringify(rect)}`);
    return rect as { x: number; y: number };
  };

  /** In-frame rect of the first `chars` characters of `sel`'s first text node. */
  const textRect = async (
    sel: string,
    chars: number,
  ): Promise<{ x: number; y: number; w: number; h: number }> => {
    const rect = await page.frameEval(
      ANNOTATE_TAG,
      `(() => {
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el || !el.firstChild) return null;
        const range = document.createRange();
        range.setStart(el.firstChild, 0);
        range.setEnd(el.firstChild, Math.min(${String(chars)}, el.firstChild.length));
        const r = range.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      })()`,
    );
    assert(
      typeof rect === "object" && rect !== null,
      `no in-frame text rect for ${sel}: ${JSON.stringify(rect)}`,
    );
    return rect as { x: number; y: number; w: number; h: number };
  };

  const popoverVisible = async (): Promise<boolean> =>
    (await page.eval(
      `(() => { const p = document.querySelector("#hr-annotate-pop"); return p && !p.hidden; })()`,
    )) === true;

  const waitPopover = async (visible: boolean): Promise<void> => {
    const ok = await page.wait(
      `(() => { const p = document.querySelector("#hr-annotate-pop"); return p && (p.hidden === ${String(!visible)}); })()`,
      20_000,
    );
    assert(ok === true, `popover visibility never became ${String(visible)}`);
  };

  /**
   * The annotator batches emits through rAF — trailing `selection` messages from
   * a drag can still be in flight when the next step types the note, and each one
   * resets the widget's draft. Poll until the count stops growing.
   */
  const quietSelections = async (): Promise<void> => {
    let last = -1;
    for (let i = 0; i < 50; i += 1) {
      const count = (await typed("hr-annotator/selection")).length;
      if (count === last) return;
      last = count;
      await sleep(120);
    }
    assert(false, "selection messages never stopped arriving");
  };

  /** Click the banner toggle and wait for the annotator's nth hello. */
  const enterAnnotate = async (helloExpected: number): Promise<void> => {
    const clicked = await page.eval(`(() => {
      const b = document.querySelector("#hr-annotate-btn");
      if (!b || b.hidden) return false;
      b.click();
      return true;
    })()`);
    assert(clicked === true, "annotate toggle missing or hidden");
    await waitTyped("hr-annotator/hello", helloExpected);
    const sandbox = await frameAttr("sandbox");
    assertEq(sandbox, "allow-scripts", "annotate frame sandbox");
    const src = await frameAttr("src");
    assert(
      typeof src === "string" && src.includes("annotate="),
      `annotate frame src carries no token: ${String(src)}`,
    );
  };

  const exitAnnotate = async (): Promise<void> => {
    const clicked = await page.eval(`(() => {
      const b = document.querySelector("#hr-annotate-btn");
      if (!b) return false;
      b.click();
      return true;
    })()`);
    assert(clicked === true, "annotate toggle missing on exit");
    const done = await page.wait(
      `(() => { const f = document.querySelector(${JSON.stringify(FRAME)}); return f && f.getAttribute("sandbox") === "" && !(f.getAttribute("src") || "").includes("annotate="); })()`,
      20_000,
    );
    assert(done === true, "sandbox/src did not restore after exit");
  };

  const grant = async (docId: string): Promise<void> => {
    const res = await api.post(`${docApi(docId)}/permissions`, { scripts: true });
    assertEq(res.status, 200, `scripts grant on ${docId}`);
  };

  /** Open the reader on another workspace document (multi-doc daemon). */
  const openDoc = async (docId: string): Promise<void> => {
    // daemon.url carries ?token=… — appending ?doc= would corrupt the query;
    // the bare origin + ?doc= is the multi-doc address form (cookie keeps auth).
    await page.navigate(
      `http://127.0.0.1:${String(daemon.port)}/?doc=${encodeURIComponent(docId)}`,
    );
    await installProbe();
    const framed = await page.wait(
      `(() => { const f = document.querySelector(${JSON.stringify(FRAME)}); return f && !f.hidden && f.getAttribute("src"); })()`,
      25_000,
    );
    assert(framed !== false, `foreign frame never mounted for ${docId}`);
  };

  beforeAll(async () => {
    home = sandbox("annotate-journey");
    await writeFile(docPath(home.ws, DOC), JOURNEY_HTML, "utf8");
    await writeFile(docPath(home.ws, FORGER_DOC), FORGER_HTML, "utf8");
    await writeFile(docPath(home.ws, POISON_DOC), POISON_HTML, "utf8");
    await writeFile(docPath(home.ws, POISON_SOFT_DOC), POISON_SOFT_HTML, "utf8");
    daemon = await startServe({ file: DOC, workspace: home.ws, home: home.home });
    api = await connect(daemon.port, daemon.token);
    browser = await launchBrowser();
    page = await browser.open(daemon.url);
    await installProbe();
    const framed = await page.wait(
      `(() => { const f = document.querySelector(${JSON.stringify(FRAME)}); return f && !f.hidden && f.getAttribute("src"); })()`,
      25_000,
    );
    assert(framed !== false, "the foreign frame never mounted");
    assertEq(await frameAttr("sandbox"), "", "off-tier sandbox should start fully restricted");
  });

  afterAll(async () => {
    await browser.close();
    await daemon.stop();
    await killAllTracked();
    home.cleanup();
  });

  test("should enter annotate mode: annotator hello, allow-scripts sandbox, page script dead", async () => {
    await enterAnnotate(1);
    await sleep(1_200);
    assert(
      !(await markers()).includes("page-ran"),
      "the page's inline script ran under scripts-off annotate",
    );
    const errors = page.consoleErrors().filter((line) => line.includes("__hr_annotator"));
    assertEq(errors.length, 0, `annotator script errors: ${errors.join(";")}`);
  });

  test("should open the popover on a real drag and land the anchor in the body text", async () => {
    const box = await frameRect();
    const rect = await textRect("#p1", 40);
    await page.drag(
      box.x + rect.x + 2,
      box.y + rect.y + rect.h / 2,
      box.x + rect.x + rect.w - 2,
      box.y + rect.y + rect.h / 2,
    );
    await waitPopover(true);
    const selections = await typed("hr-annotator/selection");
    const last = selections.at(-1);
    assert(typeof last === "object" && last !== null, "no selection message reached the parent");
    const anchor: unknown = Reflect.get(last, "anchor");
    assert(
      typeof anchor === "object" && anchor !== null,
      `selection message carries no anchor: ${JSON.stringify(last)}`,
    );
    savedAnchor = anchor as WireAnchor;
    assert(savedAnchor.exact.length > 3, `too little text selected: ${JSON.stringify(anchor)}`);
    // The anchor must index the SAME body text core computes for the file.
    const bodyText = bodyTextOf(
      parseHtml(await readFile(docPath(home.ws, DOC), "utf8"), { scriptingEnabled: true }),
    );
    assertEq(
      bodyText.slice(savedAnchor.start, savedAnchor.start + savedAnchor.exact.length),
      savedAnchor.exact,
      "the anchor does not slice the body text at `start`",
    );
    assertEq(
      bodyText.slice(Math.max(0, savedAnchor.start - 64), savedAnchor.start),
      savedAnchor.prefix,
      "prefix does not precede `start` in the body text",
    );
    assertEq(
      bodyText.slice(
        savedAnchor.start + savedAnchor.exact.length,
        savedAnchor.start + savedAnchor.exact.length + 64,
      ),
      savedAnchor.suffix,
      "suffix does not follow `start+exact.length` in the body text",
    );
  });

  test("should save the note into the on-disk sidecar and refresh highlights", async () => {
    savedNote = "第一条批注：drag-save";
    await quietSelections();
    await page.type("#hr-annotate-draft", savedNote);
    const clicked = await page.eval(`(() => {
      const b = document.querySelector("#hr-annotate-save");
      if (!b || b.hidden) return false;
      b.click();
      return true;
    })()`);
    assert(clicked === true, "save button missing");
    await waitPopover(false);
    // On disk: <ws>/.hreader/annotations/<sha1>.json — exactly one file, one record.
    const dir = join(home.ws, ".hreader", "annotations");
    const files = await until(
      async () => await readdir(dir).catch(() => [] as string[]),
      (names) => names.some((name) => name.endsWith(".json")),
      { timeoutMs: 10_000 },
    );
    const sidecar = files.find((name) => name.endsWith(".json"));
    assert(sidecar !== undefined, "no sidecar file landed under .hreader/annotations");
    const raw = JSON.parse(await readFile(join(dir, sidecar), "utf8")) as unknown;
    assert(typeof raw === "object" && raw !== null, "sidecar file is not an object");
    const list: unknown = Reflect.get(raw, "annotations");
    assert(
      Array.isArray(list) && list.length === 1,
      `sidecar annotations: ${JSON.stringify(list)}`,
    );
    const record = (list as readonly unknown[])[0];
    assert(typeof record === "object" && record !== null, "sidecar record malformed");
    const anchor: unknown = Reflect.get(record, "anchor");
    assert(typeof anchor === "object" && anchor !== null, "sidecar record has no anchor");
    // The on-disk anchor is the authority for the paint/click test: trailing
    // selection messages may have advanced the widget's pending anchor past the
    // one test 2 last observed.
    savedAnchor = anchor as WireAnchor;
    const bodyText = bodyTextOf(
      parseHtml(await readFile(docPath(home.ws, DOC), "utf8"), { scriptingEnabled: true }),
    );
    const exact: unknown = Reflect.get(anchor, "exact");
    const start: unknown = Reflect.get(anchor, "start");
    assert(typeof exact === "string" && typeof start === "number", "anchor fields malformed");
    assertEq(
      bodyText.slice(start, start + exact.length),
      exact,
      "on-disk anchor does not slice the body text",
    );
    assertEq(Reflect.get(record, "note"), savedNote, "saved note text");
    // And the API view agrees the relocation resolves.
    const listed = await api.getJson(`${docApi(DOC)}/sidecar`);
    const entries = listed["annotations"];
    assert(Array.isArray(entries) && entries.length === 1, "GET /sidecar count");
    const relocation: unknown = Reflect.get(entries[0], "relocation");
    assert(
      typeof relocation === "object" &&
        relocation !== null &&
        Reflect.get(relocation, "ok") === true,
      `relocation did not resolve: ${JSON.stringify(relocation)}`,
    );
  });

  test("should paint the saved annotation via CSS.highlights after re-entering and open the note on click", async () => {
    await exitAnnotate();
    await enterAnnotate(2);
    // The hello triggers GET /sidecar → highlights message → ranges registered.
    const texts = await page.frameWait(
      ANNOTATE_TAG,
      `(() => {
        const hl = CSS.highlights && CSS.highlights.get("hr-pending");
        if (!hl) return false;
        const out = [];
        for (const r of hl) out.push(r.toString());
        return out.length > 0 ? out : false;
      })()`,
      20_000,
    );
    assert(Array.isArray(texts), `no pending highlight in the frame: ${JSON.stringify(texts)}`);
    assert(savedAnchor !== undefined, "no saved anchor to compare the highlight against");
    assert(
      (texts as readonly string[]).includes(savedAnchor.exact),
      `highlight ranges do not cover the anchored text: ${JSON.stringify(texts)} vs ${savedAnchor.exact}`,
    );
    // Click inside the first client rect of the covering range.
    const box = await frameRect();
    const rect = await page.frameEval(
      ANNOTATE_TAG,
      `(() => {
        const hl = CSS.highlights.get("hr-pending");
        for (const r of hl) {
          const first = r.getClientRects()[0];
          if (first) return { x: first.x, y: first.y, w: first.width, h: first.height };
        }
        return null;
      })()`,
    );
    assert(
      typeof rect === "object" && rect !== null,
      `no client rect on the highlight: ${JSON.stringify(rect)}`,
    );
    const r = rect as { x: number; y: number; w: number; h: number };
    await page.mouseClick(box.x + r.x + Math.min(4, r.w / 2), box.y + r.y + r.h / 2);
    // `open` no longer opens a popover — it selects the card in the side panel.
    const selected = await page.wait(
      `(() => {
        const card = document.querySelector("#hr-ann-panel [data-hr-annotation]");
        return card && card.getAttribute("data-hr-selected") === "true";
      })()`,
      20_000,
    );
    assert(selected === true, "click on the highlight did not select the panel card");
    const note = await page.eval(
      `document.querySelector("#hr-ann-panel [data-hr-annotation] .ann-note")?.textContent`,
    );
    assertEq(note, savedNote, "the selected panel card shows the saved note");
    const popHidden = await page.eval(
      `(() => { const p = document.querySelector("#hr-annotate-pop"); return !p || p.hidden; })()`,
    );
    assert(popHidden === true, "the highlight click still opened the popover");
  });

  test("should drop forged reader-side messages: wrong source, wrong origin, malformed, oversized, unknown", async () => {
    const before = await api.getJson(`${docApi(DOC)}/sidecar`);
    const beforeCount = Array.isArray(before["annotations"]) ? before["annotations"].length : -1;

    // (a) The reader page posts to itself: source = reader window ≠ frame.
    await page.eval(
      `window.postMessage({type:"hr-annotator/selection",version:1,anchor:{exact:"Alpha",prefix:"",suffix:" ",start:0},rect:{x:1,y:1,w:9,h:9}},"*")`,
    );
    // (b) A different window posts a forged selection: a served workspace doc
    // embedded next to the reader — its source ≠ the annotate frame and its
    // origin is the real one, not "null". Two independent drop grounds.
    await grant(FORGER_DOC);
    const forgerInfo = await api.getJson(`${docApi(FORGER_DOC)}/info`);
    const forgerUrl = forgerInfo["frameUrl"];
    assert(typeof forgerUrl === "string", `forger frameUrl: ${JSON.stringify(forgerInfo)}`);
    await page.eval(`(() => {
      const f = document.createElement("iframe");
      f.id = "hr-forger-probe";
      f.src = ${JSON.stringify(forgerUrl)};
      document.body.appendChild(f);
      return true;
    })()`);
    await sleep(800);
    assert(!(await popoverVisible()), "a non-frame source opened the popover");
    await page.eval(`document.querySelector("#hr-forger-probe")?.remove()`);

    // (c) From inside the annotate frame itself (right source, right origin,
    // wrong shape): malformed anchor, oversized exact, extra key, unknown type.
    for (const forged of [
      { type: "hr-annotator/selection", version: 1, anchor: 42, rect: { x: 1, y: 1, w: 9, h: 9 } },
      {
        type: "hr-annotator/selection",
        version: 1,
        anchor: { exact: "x".repeat(600), prefix: "", suffix: "", start: 0 },
        rect: { x: 1, y: 1, w: 9, h: 9 },
      },
      {
        type: "hr-annotator/selection",
        version: 1,
        anchor: { exact: "Alpha", prefix: "", suffix: "", start: 0 },
        rect: { x: 1, y: 1, w: 9, h: 9 },
        extra: 1,
      },
      { type: "hr-annotator/evil", version: 1 },
      {
        type: "hr-annotator/selection",
        version: 2,
        anchor: { exact: "Alpha", prefix: "", suffix: "", start: 0 },
        rect: { x: 1, y: 1, w: 9, h: 9 },
      },
    ]) {
      await page.frameEval(
        ANNOTATE_TAG,
        `window.parent.postMessage(${JSON.stringify(forged)}, "*")`,
      );
    }
    await sleep(600);
    assert(!(await popoverVisible()), "a malformed frame message opened the popover");
    const after = await api.getJson(`${docApi(DOC)}/sidecar`);
    const afterCount = Array.isArray(after["annotations"]) ? after["annotations"].length : -1;
    assertEq(afterCount, beforeCount, "a forged message caused a sidecar write");
  });

  test("should honor a forged well-formed selection only up to its own sidecar POST (accepted risk D13)", async () => {
    // A scripts-ON page could post this itself; frameEval stands in for it with
    // the exact same wire shape the annotator emits.
    const forged = {
      type: "hr-annotator/selection",
      version: 1,
      anchor: { exact: "FORGED", prefix: "", suffix: "", start: 0 },
      selector: "body > p",
      rect: { x: 5, y: 5, w: 40, h: 12 },
    };
    await page.frameEval(ANNOTATE_TAG, `window.parent.postMessage(${JSON.stringify(forged)}, "*")`);
    await waitPopover(true);
    await page.type("#hr-annotate-draft", "forged-save");
    const clicked = await page.eval(`(() => {
      const b = document.querySelector("#hr-annotate-save");
      if (!b || b.hidden) return false;
      b.click();
      return true;
    })()`);
    assert(clicked === true, "save button missing for the forged selection");
    await waitPopover(false);
    const listed = await api.getJson(`${docApi(DOC)}/sidecar`);
    const entries = listed["annotations"];
    assert(Array.isArray(entries), "sidecar listing malformed");
    const forgedEntry = (entries as readonly unknown[]).find(
      (entry) =>
        typeof entry === "object" && entry !== null && Reflect.get(entry, "note") === "forged-save",
    );
    assert(
      forgedEntry !== undefined,
      "the forged selection's save never reached this doc's sidecar",
    );
  });

  test("should keep the annotator deaf to non-parent sources inside the frame", async () => {
    const sizeOf = async (): Promise<number> => {
      const value = await page.frameEval(
        ANNOTATE_TAG,
        `(() => {
          const hl = CSS.highlights && CSS.highlights.get("hr-pending");
          if (!hl) return -1;
          let n = 0;
          for (const r of hl) n += 1;
          return n;
        })()`,
      );
      return typeof value === "number" ? value : -1;
    };
    const before = await sizeOf();
    // Self-posted `highlights` from inside the frame: source = the frame's own
    // window, not the captured parent — the annotator must ignore it entirely.
    // (A nested frame would be an equally valid non-parent source, but inside
    // an opaque-origin sandbox no script can drive one cross-origin anyway.)
    await page.frameEval(
      ANNOTATE_TAG,
      `window.postMessage({type:"hr-annotator/highlights",version:1,items:[{id:"forged",start:0,end:5,status:"pending"}]},"*")`,
    );
    // Focus from a non-parent source is equally dead — no scroll, no error.
    await page.frameEval(
      ANNOTATE_TAG,
      `window.postMessage({type:"hr-annotator/focus",id:"forged"},"*")`,
    );
    await sleep(600);
    assertEq(await sizeOf(), before, "a non-parent message mutated the highlight registry");
  });

  test("should exit annotate mode: permission sandbox restored, annotator gone", async () => {
    const hellosBefore = (await typed("hr-annotator/hello")).length;
    await exitAnnotate();
    await sleep(1_200);
    const hellosAfter = (await typed("hr-annotator/hello")).length;
    assertEq(hellosAfter, hellosBefore, "the annotator kept running after exit");
    // The served normal doc carries no annotator injection.
    const src = await frameAttr("src");
    assert(typeof src === "string" && !src.includes("annotate="), "frame still on an annotate URL");
    const served = await api.get(src);
    const body = await served.text();
    assert(
      !body.includes("__hr_annotator.js"),
      "the normal frame URL still serves the annotator injection",
    );
    // Scripts stay dead on the restored off-tier sandbox.
    assert(
      !(await markers()).includes("page-ran"),
      "the page's inline script ran on the restored frame",
    );
  });

  test("should run page script AND annotator together under scripts-on annotate", async () => {
    await grant(DOC);
    const ranBefore = (await markers()).filter((m) => m === "page-ran").length;
    const hellosBefore = (await typed("hr-annotator/hello")).length;
    await enterAnnotate(hellosBefore + 1);
    const ok = await page.wait(
      `Array.isArray(window.__pp) && window.__pp.filter((m) => m === "page-ran").length > ${String(ranBefore)}`,
      15_000,
    );
    assert(ok === true, "the page script did not run under scripts-on annotate");
    // Selection still works with page scripts live.
    const box = await frameRect();
    const rect = await textRect("#p2", 30);
    await page.drag(
      box.x + rect.x + 2,
      box.y + rect.y + rect.h / 2,
      box.x + rect.x + rect.w - 2,
      box.y + rect.y + rect.h / 2,
    );
    await waitPopover(true);
    const clicked = await page.eval(`(() => {
      const b = document.querySelector("#hr-annotate-cancel");
      if (!b) return false;
      b.click();
      return true;
    })()`);
    assert(clicked === true, "cancel button missing");
    await waitPopover(false);
  });

  test("should survive a fully pre-poisoned environment without a crash or a leak", async () => {
    await grant(POISON_DOC);
    await openDoc(POISON_DOC);
    const hellosBefore = (await typed("hr-annotator/hello")).length;
    await enterAnnotate(hellosBefore + 1);
    const ok = await page.wait(
      `Array.isArray(window.__pp) && window.__pp.includes("poison-installed")`,
      15_000,
    );
    assert(ok === true, "the poison script did not run");
    // getSelection is a poisoned string → the capture is "absent": a real drag
    // produces no message and no popover — and nothing throws.
    const box = await frameRect();
    const rect = await textRect("#p1", 20);
    await page.drag(
      box.x + rect.x + 2,
      box.y + rect.y + rect.h / 2,
      box.x + rect.x + rect.w - 2,
      box.y + rect.y + rect.h / 2,
    );
    await sleep(600);
    assert(!(await popoverVisible()), "a poisoned getSelection still produced a popover");
    const crashes = page
      .consoleErrors()
      .filter((line) => line.includes("__hr_annotator") || line.includes("map-poisoned"));
    assertEq(crashes.length, 0, `poison leaked into a crash: ${crashes.join(";")}`);
    // The frame itself is still alive and evaluable.
    const alive = await page.frameEval(ANNOTATE_TAG, `1 + 1`);
    assertEq(alive, 2, "the frame context died under the poison");
  });

  test("should keep the selection path working when only map/CSS are poisoned", async () => {
    await grant(POISON_SOFT_DOC);
    await openDoc(POISON_SOFT_DOC);
    const hellosBefore = (await typed("hr-annotator/hello")).length;
    await enterAnnotate(hellosBefore + 1);
    const ok = await page.wait(
      `Array.isArray(window.__pp) && window.__pp.includes("poison-installed")`,
      15_000,
    );
    assert(ok === true, "the soft-poison script did not run");
    const box = await frameRect();
    const rect = await textRect("#p1", 20);
    await page.drag(
      box.x + rect.x + 2,
      box.y + rect.y + rect.h / 2,
      box.x + rect.x + rect.w - 2,
      box.y + rect.y + rect.h / 2,
    );
    await waitPopover(true);
    const selections = await typed("hr-annotator/selection");
    const last = selections.at(-1);
    assert(
      typeof last === "object" &&
        last !== null &&
        typeof Reflect.get(last, "anchor") === "object" &&
        Reflect.get(last, "anchor") !== null,
      "selection died under a soft-poisoned environment",
    );
    // Highlights degrade (registry poisoned) but nothing crashes.
    const crashes = page
      .consoleErrors()
      .filter((line) => line.includes("__hr_annotator") || line.includes("map-poisoned"));
    assertEq(crashes.length, 0, `soft poison leaked into a crash: ${crashes.join(";")}`);
  });
});
