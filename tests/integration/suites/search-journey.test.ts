// Search UI end-to-end in real Chrome (D61): `hr serve` boots the reader shell
// on a foreign doc → `/` opens the search panel and focuses the input → typing
// (real input pipeline, 150ms debounce) renders hits → Enter on a doc hit
// navigates the reader to that doc → an annotation hit on another doc navigates
// back *and* focuses the card (sessionStorage stash → bootForeign → annotate
// mode → `data-hr-selected`). Esc → `/` must reopen the panel — a hidden input
// that keeps DOM focus swallows the keydown through the editable guard (#54).
// API shapes live in search.test.ts; this suite only pins the browser journey.
// Every test navigates to its own doc through a full reload, so no case depends
// on the panel/focus/stash state a previous test left behind.

import { writeFile } from "node:fs/promises";

import { afterAll, beforeAll, describe, test } from "vitest";

import { assert, assertEq } from "../harness/check.ts";
import { docPath } from "../harness/cli.ts";
import { launchBrowser, type Browser, type Page } from "../harness/chrome.ts";
import { chromeSkipReason, sandbox, type TestHome } from "../harness/env.ts";
import { connect, docApi, type Api } from "../harness/http.ts";
import { killAllTracked } from "../harness/proc.ts";
import { startServe, type Daemon } from "../harness/serve.ts";

const skip = chromeSkipReason();

const DOC_A = "search-journey-a.html";
const DOC_B = "search-journey-b.html";
const BODY_A = `<!doctype html><html><head><title>维修手册</title></head><body><p>摩托车 发动机 保养</p></body></html>`;
const BODY_B = `<!doctype html><html><head><title>账本</title></head><body><p>支出 收入 结余</p></body></html>`;

const PANEL_OPEN = `(() => {
  const p = document.querySelector('#hr-search-panel');
  return p && !p.hidden && document.activeElement === document.querySelector('#hr-search-input');
})()`;
const PANEL_CLOSED = `(() => {
  const p = document.querySelector('#hr-search-panel');
  return p && p.hidden;
})()`;
const PANEL_OPEN_EMPTY = `(() => {
  const p = document.querySelector('#hr-search-panel');
  const i = document.querySelector('#hr-search-input');
  return p && !p.hidden && i && i.value === '' && document.activeElement === i;
})()`;
const CAPABILITY = `document.querySelector('#hr-root') && document.querySelector('#hr-root').hasAttribute('data-hr-search')`;
const DOC_ITEMS = `document.querySelectorAll('#hr-search-docs-list li').length`;
const ANN_ITEMS = `document.querySelectorAll('#hr-search-anns-list li').length`;

describe.skipIf(skip !== undefined)("search-ui-journey", () => {
  let home: TestHome;
  let daemon: Daemon;
  let api: Api;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    home = sandbox("search-journey");
    await writeFile(docPath(home.ws, DOC_A), BODY_A, "utf8");
    await writeFile(docPath(home.ws, DOC_B), BODY_B, "utf8");
    daemon = await startServe({ file: DOC_A, workspace: home.ws, home: home.home });
    api = await connect(daemon.port, daemon.token);
    // Seed one sidecar annotation on DOC_A through the real HTTP route so the
    // index (and later the annotate panel) sees the same store the daemon writes.
    const added = await api.postJson(`${docApi(DOC_A)}/sidecar`, {
      anchor: { exact: "发动机", prefix: "", suffix: "", start: 4 },
      selector: "body > p:nth-of-type(1)",
      note: "下次换全合成机油",
    });
    assert(typeof added["id"] === "string", `sidecar add failed: ${JSON.stringify(added)}`);
    browser = await launchBrowser();
    page = await browser.open(daemon.url);
  });

  afterAll(async () => {
    await browser.close();
    await daemon.stop();
    await killAllTracked();
    home.cleanup();
  });

  /** Per-test starting state: a full reload onto `doc` leaves the panel closed and DOM focus on the body. */
  const startOn = async (docId: string): Promise<void> => {
    // daemon.url carries ?token=… — appending ?doc= would corrupt the query;
    // the bare origin + ?doc= is the multi-doc address form (cookie keeps auth).
    await page.navigate(
      `http://127.0.0.1:${String(daemon.port)}/?doc=${encodeURIComponent(docId)}`,
    );
    const ready = await page.wait(`(${CAPABILITY}) && (${PANEL_CLOSED})`, 25_000);
    assert(ready === true, `the reader shell never came up closed on ${docId}`);
  };

  test("should open the panel on /, close on Esc and reopen with an empty input", async () => {
    await startOn(DOC_A);
    await page.key("/", "Slash", 191);
    const opened = await page.wait(PANEL_OPEN);
    assert(opened === true, "/ did not open the search panel with a focused input");

    await page.type("#hr-search-input", "账");
    await page.key("Escape", "Escape", 27);
    const closed = await page.wait(PANEL_CLOSED);
    assert(closed === true, "Esc did not close the search panel");

    // The #54 regression: this / must reopen the panel even though the previous
    // one just hid — the hidden input must not still hold DOM focus, or the
    // keydown targets it and the editable guard swallows the shortcut.
    await page.key("/", "Slash", 191);
    const reopened = await page.wait(PANEL_OPEN_EMPTY);
    assert(reopened === true, "the panel did not reopen with a focused empty input");

    // ERR_ABORTED is the subframe load cancelled by a full-page navigation —
    // expected on this journey; anything else is a real failure.
    const errors = page.consoleErrors().filter((line) => !line.includes("ERR_ABORTED"));
    assert(errors.length === 0, `page errors during open/close/reopen: ${JSON.stringify(errors)}`);
  });

  test("should render a doc hit and navigate the reader to it on Enter", async () => {
    await startOn(DOC_A);
    await page.key("/", "Slash", 191);
    assert((await page.wait(PANEL_OPEN)) === true, "panel did not reopen");
    await page.type("#hr-search-input", "账本");
    const hits = await page.wait(
      `(${DOC_ITEMS}) === 1 && document.querySelector('#hr-search-docs-list li').textContent.includes('账本')`,
    );
    assert(hits === true, "the doc hit for DOC_B never rendered");

    await page.key("Enter", "Enter", 13);
    const arrived = await page.wait(
      `location.search.includes('doc=${DOC_B}') && ${CAPABILITY}`,
      25_000,
    );
    assert(arrived === true, `the reader never navigated to ${DOC_B}`);
    // Sanity that the new page actually hosts DOC_B, not a stale shell.
    const framed = await page.wait(
      `(() => { const f = document.querySelector('#hr-foreign-frame'); return f && f.getAttribute('src') && f.getAttribute('src').includes(${JSON.stringify(DOC_B)}); })()`,
      25_000,
    );
    assert(framed === true, "the foreign frame never pointed at DOC_B");
  });

  test("should open an annotation hit on another doc and focus its card", async () => {
    // The annotation lives on DOC_A — opening the hit from DOC_B must navigate
    // AND land the card focused (the stash survives the reload).
    await startOn(DOC_B);
    await page.key("/", "Slash", 191);
    assert((await page.wait(PANEL_OPEN)) === true, "panel did not reopen on DOC_B");
    await page.type("#hr-search-input", "全合成机油");
    const hits = await page.wait(`(${ANN_ITEMS}) === 1`);
    assert(hits === true, "the annotation hit never rendered");

    await page.key("Enter", "Enter", 13);
    const arrived = await page.wait(
      `location.search.includes('doc=${DOC_A}') && ${CAPABILITY}`,
      25_000,
    );
    assert(arrived === true, `the reader never navigated back to ${DOC_A}`);
    // bootForeign consumed the stash → focusAnnotation → annotate mode → the
    // panel selects the card once the sidecar list lands.
    const selected = await page.wait(
      `document.querySelector('#hr-ann-panel [data-hr-selected="true"]')`,
      30_000,
    );
    assert(selected !== false && selected !== undefined, "the annotation card never got focus");
    // The stash is one-shot: a second boot of DOC_A must not re-focus.
    const raw = await page.eval(`window.sessionStorage.getItem('hr-search-focus')`);
    assertEq(raw, null, "the search-focus stash was left behind");
    const errors = page.consoleErrors().filter((line) => !line.includes("ERR_ABORTED"));
    assert(
      errors.length === 0,
      `page errors during the annotation journey: ${JSON.stringify(errors)}`,
    );
  });
});
