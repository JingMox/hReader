// D55 annotation-panel journey, end-to-end in real Chrome against a real
// `hr serve`: entering annotate mode opens the side panel → two real mouse-drag
// annotations list under 待处理 → reply / resolve / reopen / delete(confirm) go
// through the sidecar routes and repaint panel + frame highlights → a card
// click scrolls the frame to its highlight → a highlight click selects the
// card → an external edit that breaks the anchor moves the card to 找不到位置.
// The popover-selection/create flow and the adversarial half live in
// annotate-journey.test.ts; this suite only covers the panel.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, test } from "vitest";

import { assert, assertEq } from "../harness/check.ts";
import { docPath } from "../harness/cli.ts";
import { launchBrowser, type Browser, type Page } from "../harness/chrome.ts";
import { chromeSkipReason, sandbox, until, type TestHome } from "../harness/env.ts";
import { connect, docApi, type Api } from "../harness/http.ts";
import { killAllTracked } from "../harness/proc.ts";
import { startServe, type Daemon } from "../harness/serve.ts";

const skip = chromeSkipReason();

const DOC = "panel.html";
const FRAME = "#hr-foreign-frame";
const ANNOTATE_TAG = "/f/";

// A scripts-bearing foreign document with two uniquely anchored paragraphs at
// the BOTTOM of ~three viewports of filler — a panel-card click must really
// scroll the frame to reach them. No <article> keeps cls=foreign.
const filler = Array.from(
  { length: 40 },
  (_, i) => `<p>Filler block ${String(i)}. Padding text only, nothing anchored here.</p>`,
).join("\n");

const PANEL_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>annotate panel journey</title></head>
<body>
<main id="main">
${filler}
<p id="pa">First anchored phrase zulu xray whiskey victor uniform tango sierra.</p>
<p id="pb">Second anchored phrase hotel golf echo charlie bravo alpha delta.</p>
</main>
<script>parent.postMessage('page-ran','*');</script>
</body></html>`;

// The external edit: identical skeleton, but pb's anchored words are gone so
// the second annotation can no longer be located.
const PANEL_HTML_EDITED = PANEL_HTML.replace(
  "Second anchored phrase hotel golf echo charlie bravo alpha delta.",
  "The replacement sentence has none of the old anchor words inside it.",
);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(skip !== undefined)("annotate-panel-journey", () => {
  let home: TestHome;
  let daemon: Daemon;
  let api: Api;
  let browser: Browser;
  let page: Page;
  let idA = "";
  let idB = "";
  let exactA = "";
  let exactB = "";

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

  const waitTyped = async (type: string, expected: number): Promise<void> => {
    const ok = await page.wait(
      `Array.isArray(window.__pp) && window.__pp.filter((m) => m && m.type === ${JSON.stringify(type)}).length >= ${String(expected)}`,
      20_000,
    );
    assert(ok === true, `expected ${String(expected)} "${type}" messages`);
  };

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
    assert(typeof rect === "object" && rect !== null, `no in-frame rect for ${sel}`);
    return rect as { x: number; y: number; w: number; h: number };
  };

  const waitPopover = async (visible: boolean): Promise<void> => {
    const ok = await page.wait(
      `(() => { const p = document.querySelector("#hr-annotate-pop"); return p && (p.hidden === ${String(!visible)}); })()`,
      20_000,
    );
    assert(ok === true, `popover visibility never became ${String(visible)}`);
  };

  /** See annotate-journey: the annotator batches emits through rAF. */
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

  /** Drag across `sel`, wait for the popover, type the note, save. */
  const createAnnotation = async (sel: string, note: string): Promise<void> => {
    // The anchored paragraphs sit below the fold — bring sel into the viewport
    // first so the drag coordinates land inside the frame.
    await page.frameEval(
      ANNOTATE_TAG,
      `document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: "center" })`,
    );
    await sleep(300);
    const box = await frameRect();
    const rect = await textRect(sel, 30);
    await page.drag(
      box.x + rect.x + 2,
      box.y + rect.y + rect.h / 2,
      box.x + rect.x + rect.w - 2,
      box.y + rect.y + rect.h / 2,
    );
    await waitPopover(true);
    await quietSelections();
    await page.type("#hr-annotate-draft", note);
    const clicked = await page.eval(`(() => {
      const b = document.querySelector("#hr-annotate-save");
      if (!b || b.hidden) return false;
      b.click();
      return true;
    })()`);
    assert(clicked === true, `save button missing for ${note}`);
    await waitPopover(false);
  };

  /** The id of the sidecar entry carrying `note` (or "" while absent). */
  const idOfNote = async (note: string): Promise<string> => {
    const listed = await api.getJson(`${docApi(DOC)}/sidecar`);
    const entries = listed["annotations"];
    if (!Array.isArray(entries)) return "";
    const hit = (entries as readonly unknown[]).find(
      (entry) => typeof entry === "object" && entry !== null && Reflect.get(entry, "note") === note,
    );
    if (hit === undefined || typeof hit !== "object" || hit === null) return "";
    const id: unknown = Reflect.get(hit, "id");
    return typeof id === "string" ? id : "";
  };

  const waitCards = async (listSel: string, expected: number): Promise<void> => {
    const ok = await page.wait(
      `document.querySelectorAll(${JSON.stringify(`${listSel} [data-hr-annotation]`)}).length >= ${String(expected)}`,
      20_000,
    );
    assert(ok === true, `expected ${String(expected)} cards under ${listSel}`);
  };

  const clickAction = async (id: string, action: string): Promise<void> => {
    const clicked = await page.eval(`(() => {
      const b = document.querySelector(${JSON.stringify(
        `#hr-ann-panel [data-hr-annotation="${id}"] [data-hr-action="${action}"]`,
      )});
      if (!b) return false;
      b.click();
      return true;
    })()`);
    assert(clicked === true, `no ${action} action on card ${id}`);
  };

  const cardIn = async (listSel: string, id: string): Promise<boolean> =>
    (await page.eval(
      `(() => { const c = document.querySelector(${JSON.stringify(
        `${listSel} [data-hr-annotation="${id}"]`,
      )}); return c !== null; })()`,
    )) === true;

  beforeAll(async () => {
    home = sandbox("annotate-panel-journey");
    await writeFile(docPath(home.ws, DOC), PANEL_HTML, "utf8");
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
  });

  afterAll(async () => {
    await browser.close();
    await daemon.stop();
    await killAllTracked();
    home.cleanup();
  });

  test("should open the panel on annotate enter and list two drag-saved annotations", async () => {
    const clicked = await page.eval(`(() => {
      const b = document.querySelector("#hr-annotate-btn");
      if (!b || b.hidden) return false;
      b.click();
      return true;
    })()`);
    assert(clicked === true, "annotate toggle missing or hidden");
    await waitTyped("hr-annotator/hello", 1);
    // The panel opens with the mode: aside unhidden + the root marker set.
    const opened = await page.wait(
      `(() => {
        const p = document.querySelector("#hr-ann-panel");
        const r = document.querySelector("#hr-root");
        return p && r && !p.hidden && r.hasAttribute("data-hr-annotate");
      })()`,
      20_000,
    );
    assert(opened === true, "the annotation panel did not open with annotate mode");
    const errors = page.consoleErrors().filter((line) => line.includes("__hr_annotator"));
    assertEq(errors.length, 0, `annotator script errors: ${errors.join(";")}`);

    await createAnnotation("#pa", "panel-note-A");
    await createAnnotation("#pb", "panel-note-B");
    await waitCards("#hr-ann-pending", 2);

    idA = await idOfNote("panel-note-A");
    idB = await idOfNote("panel-note-B");
    assert(idA !== "" && idB !== "", `sidecar ids: A=${idA} B=${idB}`);
    // exact strings the frame anchored (for the highlight/viewport assertions).
    const listed = await api.getJson(`${docApi(DOC)}/sidecar`);
    const entries = listed["annotations"];
    assert(Array.isArray(entries), "sidecar listing malformed");
    for (const entry of entries as readonly unknown[]) {
      if (typeof entry !== "object" || entry === null) continue;
      const note: unknown = Reflect.get(entry, "note");
      const anchor: unknown = Reflect.get(entry, "anchor");
      const exact: unknown =
        typeof anchor === "object" && anchor !== null ? Reflect.get(anchor, "exact") : "";
      if (note === "panel-note-A") exactA = typeof exact === "string" ? exact : "";
      if (note === "panel-note-B") exactB = typeof exact === "string" ? exact : "";
    }
    assert(exactA.length > 3 && exactB.length > 3, `anchors: ${exactA} / ${exactB}`);
    assert(await cardIn("#hr-ann-pending", idA), "card A not in the pending list");
    assert(await cardIn("#hr-ann-pending", idB), "card B not in the pending list");
    const painted = await page.frameWait(
      ANNOTATE_TAG,
      `(() => {
        const hl = CSS.highlights && CSS.highlights.get("hr-pending");
        if (!hl) return false;
        let n = 0;
        for (const r of hl) n += 1;
        return n === 2;
      })()`,
      20_000,
    );
    assert(painted === true, "both highlights never landed in the frame registry");
  });

  test("should reply through the panel inline box and persist the reply in the sidecar", async () => {
    await clickAction(idA, "reply");
    const boxReady = await page.wait(
      `document.querySelector(${JSON.stringify(
        `#hr-ann-panel [data-hr-annotation="${idA}"] .ann-reply-input`,
      )}) !== null`,
      10_000,
    );
    assert(boxReady === true, "the reply box never opened");
    await page.type(
      `#hr-ann-panel [data-hr-annotation="${idA}"] .ann-reply-input`,
      "panel-reply-1",
    );
    await clickAction(idA, "reply-send");
    const rendered = await page.wait(
      `(() => {
        const c = document.querySelector(${JSON.stringify(
          `#hr-ann-panel [data-hr-annotation="${idA}"] .ann-replies`,
        )});
        return c && c.textContent.includes("panel-reply-1");
      })()`,
      20_000,
    );
    assert(rendered === true, "the reply never rendered on the card");
    const listed = await api.getJson(`${docApi(DOC)}/sidecar`);
    const entry = (listed["annotations"] as readonly unknown[]).find(
      (item) => typeof item === "object" && item !== null && Reflect.get(item, "id") === idA,
    );
    const replies: unknown =
      typeof entry === "object" && entry !== null ? Reflect.get(entry, "replies") : [];
    assert(
      Array.isArray(replies) &&
        replies.some(
          (r) => typeof r === "object" && r !== null && Reflect.get(r, "note") === "panel-reply-1",
        ),
      `the reply never reached the sidecar: ${JSON.stringify(entry)}`,
    );
  });

  test("should resolve an annotation into the resolved group and reopen it", async () => {
    await clickAction(idB, "resolve");
    const moved = await page.wait(
      `document.querySelector(${JSON.stringify(
        `#hr-ann-resolved [data-hr-annotation="${idB}"]`,
      )}) !== null`,
      20_000,
    );
    assert(moved === true, "card B never moved to the resolved group");
    const listed = await api.getJson(`${docApi(DOC)}/sidecar`);
    const entry = (listed["annotations"] as readonly unknown[]).find(
      (item) => typeof item === "object" && item !== null && Reflect.get(item, "id") === idB,
    );
    assertEq(
      typeof entry === "object" && entry !== null ? Reflect.get(entry, "status") : "",
      "resolved",
      "B never became resolved in the sidecar",
    );

    await clickAction(idB, "reopen");
    const back = await page.wait(
      `document.querySelector(${JSON.stringify(
        `#hr-ann-pending [data-hr-annotation="${idB}"]`,
      )}) !== null`,
      20_000,
    );
    assert(back === true, "card B never moved back to pending");
  });

  test("should scroll the frame to a card's highlight when the card is clicked", async () => {
    // Top of the document: both highlights sit far below the viewport.
    await page.frameEval(ANNOTATE_TAG, `window.scrollTo(0, 0)`);
    await sleep(300);
    const top = await page.frameEval(ANNOTATE_TAG, `window.scrollY`);
    assert(top === 0, `frame did not scroll to top: ${String(top)}`);
    const outOfView = await page.frameEval(
      ANNOTATE_TAG,
      `(() => {
        const hl = CSS.highlights.get("hr-pending");
        for (const r of hl) {
          const b = r.getBoundingClientRect();
          if (b.top < window.innerHeight && b.bottom > 0) return true;
        }
        return false;
      })()`,
    );
    assert(outOfView === false, "a highlight already sat in the viewport — doc too short");

    const clicked = await page.eval(`(() => {
      const n = document.querySelector(${JSON.stringify(
        `#hr-ann-panel [data-hr-annotation="${idA}"] .ann-note`,
      )});
      if (!n) return false;
      n.click();
      return true;
    })()`);
    assert(clicked === true, "card A has no .ann-note to click");
    const inView = await page.frameWait(
      ANNOTATE_TAG,
      `(() => {
        const hl = CSS.highlights.get("hr-pending");
        for (const r of hl) {
          if (r.toString() !== ${JSON.stringify(exactA)}) continue;
          const b = r.getBoundingClientRect();
          if (b.top < window.innerHeight && b.bottom > 0) return true;
        }
        return false;
      })()`,
      20_000,
    );
    assert(inView === true, "the frame never scrolled A's highlight into view");
    const selected = await page.wait(
      `(() => { const c = document.querySelector(${JSON.stringify(
        `#hr-ann-panel [data-hr-annotation="${idA}"]`,
      )}); return c && c.getAttribute("data-hr-selected") === "true"; })()`,
      10_000,
    );
    assert(selected === true, "the click did not mark card A selected");
  });

  test("should delete an annotation from the panel, the sidecar file and the highlights", async () => {
    await clickAction(idA, "delete");
    const confirmUp = await page.wait(
      `document.querySelector(${JSON.stringify(
        `#hr-ann-panel [data-hr-annotation="${idA}"] .ann-confirm`,
      )}) !== null`,
      10_000,
    );
    assert(confirmUp === true, "the delete confirm never appeared");
    await clickAction(idA, "delete-yes");
    const gone = await page.wait(
      `document.querySelector(${JSON.stringify(
        `#hr-ann-panel [data-hr-annotation="${idA}"]`,
      )}) === null`,
      20_000,
    );
    assert(gone === true, "card A stayed in the panel after delete");

    // On-disk sidecar: exactly one annotation remains.
    const dir = join(home.ws, ".hreader", "annotations");
    const files = await until(
      async () => {
        const names = await readdir(dir).catch(() => [] as string[]);
        for (const name of names) {
          if (!name.endsWith(".json")) continue;
          const raw = JSON.parse(await readFile(join(dir, name), "utf8")) as unknown;
          const list: unknown =
            typeof raw === "object" && raw !== null ? Reflect.get(raw, "annotations") : [];
          if (Array.isArray(list) && list.length === 1) return names;
        }
        return [] as string[];
      },
      (names) => names.length > 0,
      { timeoutMs: 10_000 },
    );
    assert(files.length > 0, "no sidecar file under .hreader/annotations");
    const raw = JSON.parse(
      await readFile(join(dir, files.find((n) => n.endsWith(".json")) ?? ""), "utf8"),
    ) as unknown;
    const list: unknown =
      typeof raw === "object" && raw !== null ? Reflect.get(raw, "annotations") : [];
    assert(Array.isArray(list) && list.length === 1, `sidecar count: ${JSON.stringify(list)}`);
    const kept = (list as readonly unknown[])[0];
    assert(
      typeof kept === "object" && kept !== null && Reflect.get(kept, "id") === idB,
      "the wrong annotation survived the delete",
    );

    // The frame registry drops A: only B's highlight stays.
    const shrunk = await page.frameWait(
      ANNOTATE_TAG,
      `(() => {
        const hl = CSS.highlights.get("hr-pending");
        if (!hl) return true;
        const left = [];
        for (const r of hl) left.push(r.toString());
        return left.length === 1 && left[0] === ${JSON.stringify(exactB)};
      })()`,
      20_000,
    );
    assert(shrunk === true, "A's highlight survived the delete in the frame");
  });

  test("should select the panel card when the frame highlight is clicked", async () => {
    // B's highlight can sit outside the viewport — scroll #pb in before the
    // click (the range's startContainer can be boundary whitespace under main).
    await page.frameEval(
      ANNOTATE_TAG,
      `document.querySelector("#pb")?.scrollIntoView({ block: "center" })`,
    );
    await sleep(300);
    const box = await frameRect();
    const rect = await page.frameEval(
      ANNOTATE_TAG,
      `(() => {
        const hl = CSS.highlights.get("hr-pending");
        for (const r of hl) {
          if (r.toString() !== ${JSON.stringify(exactB)}) continue;
          const first = r.getClientRects()[0];
          if (first) return { x: first.x, y: first.y, w: first.width, h: first.height };
        }
        return null;
      })()`,
    );
    assert(
      typeof rect === "object" && rect !== null,
      `no client rect on B's highlight: ${JSON.stringify(rect)}`,
    );
    const r = rect as { x: number; y: number; w: number; h: number };
    await page.mouseClick(box.x + r.x + Math.min(4, r.w / 2), box.y + r.y + r.h / 2);
    const selected = await page.wait(
      `(() => { const c = document.querySelector(${JSON.stringify(
        `#hr-ann-panel [data-hr-annotation="${idB}"]`,
      )}); return c && c.getAttribute("data-hr-selected") === "true"; })()`,
      20_000,
    );
    assert(selected === true, "clicking B's highlight did not select its card");
    const popHidden = await page.eval(
      `(() => { const p = document.querySelector("#hr-annotate-pop"); return !p || p.hidden; })()`,
    );
    assert(popHidden === true, "the highlight click opened the popover");
  });

  test("should move the annotation to 找不到位置 after an external edit breaks its anchor", async () => {
    const hellosBefore = (await typed("hr-annotator/hello")).length;
    await writeFile(docPath(home.ws, DOC), PANEL_HTML_EDITED, "utf8");
    // doc.changed → annotate reloads the frame (fresh token, new hello) → the
    // refreshed list resolves B's anchor as lost.
    await waitTyped("hr-annotator/hello", hellosBefore + 1);
    const lost = await page.wait(
      `(() => {
        const group = document.querySelector("#hr-ann-group-lost");
        const card = document.querySelector(${JSON.stringify(
          `#hr-ann-lost [data-hr-annotation="${idB}"]`,
        )});
        return group && !group.hidden && card !== null;
      })()`,
      25_000,
    );
    assert(lost === true, "card B never appeared under 找不到位置");
    const reason = await page.eval(
      `document.querySelector(${JSON.stringify(
        `#hr-ann-lost [data-hr-annotation="${idB}"] .ann-lost`,
      )})?.textContent`,
    );
    assert(
      typeof reason === "string" && reason.length > 0,
      `the lost card shows no reason: ${JSON.stringify(reason)}`,
    );
    // Pending/resolved groups are empty; the frame registry dropped the range.
    const emptied = await page.frameWait(
      ANNOTATE_TAG,
      `(() => {
        const hl = CSS.highlights && CSS.highlights.get("hr-pending");
        if (!hl) return true;
        let n = 0;
        for (const r of hl) n += 1;
        return n === 0;
      })()`,
      20_000,
    );
    assert(emptied === true, "a highlight survived the lost anchor");
    // Clicking a lost card is safe: it selects (inert) and never scrolls the frame.
    const clicked = await page.eval(`(() => {
      const n = document.querySelector(${JSON.stringify(
        `#hr-ann-lost [data-hr-annotation="${idB}"] .ann-note`,
      )});
      if (!n) return false;
      n.click();
      return true;
    })()`);
    assert(clicked === true, "the lost card has no .ann-note");
    const selected = await page.wait(
      `(() => { const c = document.querySelector(${JSON.stringify(
        `#hr-ann-lost [data-hr-annotation="${idB}"]`,
      )}); return c && c.getAttribute("data-hr-selected") === "true"; })()`,
      10_000,
    );
    assert(selected === true, "the lost card did not take the selection");
  });
});
