// Journey 2 (foreign HTML end-to-end): a JS-driven animated deck lands in the
// workspace → reader read-only banner → click "allow scripts" → the grant is
// persisted under a path key (scripts dimension only) → iframe allow-scripts,
// the scripts really run (opaque origin, liveness via a postMessage probe) →
// the reader switches theme (in-page, 0-token) + /api/style writes to disk →
// **the path-keyed grant survives**, the heartbeat never stops → undo restores
// the bytes and the grant still stands (the key ignores content) →
// `hr import` adopts it as *.hr.html.
// The adversarial side of path semantics and global modes lives in
// permissions-journey; here we only pin the journey's main chain.

import { readFile, rename, writeFile } from "node:fs/promises";

import { afterAll, beforeAll, describe, test } from "vitest";

import { assert, assertEq, assertIncludes } from "../harness/check.ts";
import { dataOf, docPath, hr } from "../harness/cli.ts";
import { launchBrowser, type Browser, type Page } from "../harness/chrome.ts";
import { chromeSkipReason, sandbox, sha256File, until, type TestHome } from "../harness/env.ts";
import { connect, docApi, type Api } from "../harness/http.ts";
import { killAllTracked } from "../harness/proc.ts";
import { startServe, type Daemon } from "../harness/serve.ts";

const skip = chromeSkipReason();

// JS-driven deck: the postMessage heartbeat is the only observable channel across an opaque origin.
const FOREIGN_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>外来演示</title></head>
<body>
<h1>外来动画演示稿</h1>
<div id="stage"></div>
<script>
  let n = 0;
  setInterval(() => { n += 1; parent.postMessage('foreign-ran', '*'); }, 40);
</script>
</body></html>`;

interface DocInfo {
  readonly trust?: unknown;
  readonly cls?: unknown;
  readonly permissions?: {
    readonly scripts?: unknown;
    readonly network?: unknown;
    readonly scriptsSource?: unknown;
    readonly networkSource?: unknown;
    readonly modes?: unknown;
  };
}

describe.skipIf(skip !== undefined)("foreign-journey", () => {
  const DOC = "deck.html";
  let home: TestHome;
  let daemon: Daemon;
  let api: Api;
  let browser: Browser;
  let page: Page;
  let originalSha = "";

  const docInfo = async (docId = DOC): Promise<DocInfo> =>
    await api.getJson(`${docApi(docId)}/info`);

  /** Probe count: reads window.__foreignMsgs.length (the listener attaches right after page load). */
  const msgCount = async (): Promise<number> => {
    const value = await page.eval(
      `Array.isArray(window.__foreignMsgs) ? window.__foreignMsgs.length : -1`,
    );
    return typeof value === "number" ? value : -1;
  };

  /** Whether the count still grows within the sampling window (script liveness = heartbeats still arriving). */
  const beating = async (windowMs: number): Promise<boolean> => {
    const before = await msgCount();
    await new Promise((resolve) => setTimeout(resolve, windowMs));
    const after = await msgCount();
    return after > before;
  };

  beforeAll(async () => {
    home = sandbox("foreign");
    await writeFile(docPath(home.ws, DOC), FOREIGN_HTML, "utf8");
    originalSha = sha256File(await readFile(docPath(home.ws, DOC)));
    daemon = await startServe({ file: DOC, workspace: home.ws, home: home.home });
    api = await connect(daemon.port, daemon.token);
    browser = await launchBrowser();
    page = await browser.open(daemon.url);
    // Attach the probe listener before waiting for the first frame: missing
    // early beats doesn't matter, only the deltas count later.
    await page.eval(`(() => {
      window.__foreignMsgs = [];
      window.addEventListener('message', (e) => {
        if (e.data === 'foreign-ran') window.__foreignMsgs.push(1);
      });
      return true;
    })()`);
  });

  afterAll(async () => {
    await browser.close();
    await daemon.stop();
    await killAllTracked();
    home.cleanup();
  });

  test("should pin trust=off, both permissions off, a read-only banner and a fully restricted sandbox on a foreign doc, with scripts not running", async () => {
    const info = await docInfo();
    assertEq(info.trust, "off", "foreign doc initial trust");
    assertEq(info.cls, "foreign", "foreign doc classification");
    assertEq(info.permissions?.scripts, false, "foreign doc initial scripts");
    assertEq(info.permissions?.network, false, "foreign doc initial network");
    assertEq(info.permissions?.scriptsSource, "doc", "initial scripts source");
    const banner = await page.wait(
      `(() => { const el = document.querySelector('#hr-foreign'); return el && !el.hidden && el.textContent.includes('只读'); })()`,
      25_000,
    );
    assert(banner === true, "the read-only banner did not appear");
    const sandboxAttr = await page.eval(
      `(() => { const f = document.querySelector('#hr-foreign-frame'); return f ? f.getAttribute('sandbox') : 'no-frame'; })()`,
    );
    assertEq(sandboxAttr, "", "the off-tier sandbox should be the fully restricted empty string");
    // "Scripts didn't run" can only be proven by zero heartbeats over the
    // window: the iframe's first load and the heartbeat interval are both far
    // below the window.
    assert(
      !(await beating(1200)),
      "the foreign script unexpectedly has a heartbeat under trust=off",
    );
  });

  test("should POST {scripts:true} and run scripts under sandbox=allow-scripts when the banner's allow action is clicked", async () => {
    const clicked = await page.eval(`(() => {
      const el = document.querySelector('#hr-foreign-action');
      if (!el) return false;
      el.click();
      return true;
    })()`);
    assert(clicked === true, "grant button #hr-foreign-action not found");
    const granted = await page.wait(
      `(() => { const f = document.querySelector('#hr-foreign-frame'); return f && f.getAttribute('sandbox') === 'allow-scripts'; })()`,
    );
    assert(granted === true, "sandbox did not become allow-scripts after the grant");
    const info = await docInfo();
    assertEq(info.trust, "local", "trust after the grant (compat field = scripts in effect)");
    assertEq(info.permissions?.scripts, true, "scripts after the grant");
    assertEq(info.permissions?.network, false, "network still off after the grant");
    const ran = await page.wait(
      `Array.isArray(window.__foreignMsgs) && window.__foreignMsgs.length > 0`,
      15_000,
    );
    assert(ran === true, "no script heartbeat inside the iframe after the grant");
  });

  test("should keep the path-keyed grant, trust=local and the heartbeat when /api/style rewrites the bytes", async () => {
    // The framed-mode theme selector is bound to the themes list and switching
    // writes to disk — it shares the /api/style path with managed documents,
    // same as the desktop behavior. Pinned: non-empty options, interactive,
    // current value inside the list.
    const themeCtl = await page.eval(`(() => {
      const sel = document.querySelector('#hr-theme-select');
      return sel
        ? { options: sel.options.length, disabled: sel.disabled, value: sel.value }
        : 'absent';
    })()`);
    const themes = await api.getJson("/api/theme");
    const ids = themes["themes"];
    assert(
      Array.isArray(ids) &&
        ids.length > 0 &&
        ids.every((id): id is string => typeof id === "string"),
      "/api/theme list is empty",
    );
    assert(
      typeof themeCtl === "object" && themeCtl !== null,
      `framed-mode theme selector absent: ${JSON.stringify(themeCtl)}`,
    );
    assert(
      Reflect.get(themeCtl, "options") === ids.length &&
        Reflect.get(themeCtl, "disabled") === false,
      `framed-mode theme selector unusable: ${JSON.stringify(themeCtl)}`,
    );
    const current: unknown = Reflect.get(themeCtl, "value");
    assert(
      typeof current === "string" && ids.includes(current),
      `the selector's current value is not in the theme list: ${JSON.stringify(themeCtl)}`,
    );

    // The write path: trigger /api/style through the selector — <style
    // id="hr-theme"> lands inside the foreign document; the content changed but
    // the path-keyed grant survives by design (the point of this feature).
    const target = ids.find((id) => id !== current);
    assert(target !== undefined, "/api/theme list has no alternative theme to switch to");
    const switched = await page.eval(`(() => {
      const sel = document.querySelector('#hr-theme-select');
      sel.value = ${JSON.stringify(target)};
      sel.dispatchEvent(new Event('change'));
      return sel.value;
    })()`);
    assertEq(switched, target, "the selector's return value after switching theme");
    // The write is an async fetch: poll the file until <style id="hr-theme">
    // lands on disk (no fixed sleeps allowed).
    const fileNow = await until(
      async () => await readFile(docPath(home.ws, DOC), "utf8"),
      (text) => text.includes('id="hr-theme"'),
      { timeoutMs: 15_000 },
    );
    assert(
      fileNow.includes('id="hr-theme"'),
      "the theme <style id=hr-theme> was not written into the file",
    );

    // The core path-key semantics assertion: the sha changed, the grant did not.
    const info = await docInfo();
    assertEq(
      info.trust,
      "local",
      "trust must still be local after the write (the path key ignores bytes)",
    );
    assertEq(info.permissions?.scripts, true, "scripts still on after the write");
    // The effective combination didn't change → the widget doesn't reload the
    // iframe: the heartbeat should be continuous, never "die then revive".
    assert(
      await beating(1500),
      "the foreign script's heartbeat stopped after the write (an unchanged combination should not reload)",
    );
    const sandboxAttr = await page.eval(
      `document.querySelector('#hr-foreign-frame').getAttribute('sandbox')`,
    );
    assertEq(sandboxAttr, "allow-scripts", "sandbox should stay allow-scripts after the write");
  });

  test("should keep trust=local when undo restores the original bytes (the grant is content-agnostic)", async () => {
    const undo = await hr(["undo", DOC, "--workspace", home.ws, "--json"], { cwd: home.ws });
    assertEq(undo.code, 0, "undo exit code for the theme write");
    const restoredSha = sha256File(await readFile(docPath(home.ws, DOC)));
    assertEq(
      restoredSha,
      originalSha,
      "sha should return to the foreign doc's original bytes after undo",
    );
    const info = await docInfo();
    assertEq(info.trust, "local", "trust should still be local after undo (byte-agnostic)");
    const beforeBeats = await msgCount();
    const beatingAgain = await page.wait(
      `Array.isArray(window.__foreignMsgs) && window.__foreignMsgs.length > ${String(beforeBeats)}`,
      15_000,
    );
    assert(beatingAgain === true, "the foreign script's heartbeat did not resume after undo");
  });

  test("should void the grant on rename and restore it when the path returns", async () => {
    const ROAM = "roam.html";
    const MOVED = "roam-moved.html";
    await writeFile(docPath(home.ws, ROAM), FOREIGN_HTML, "utf8");
    const grant = await api.post(`${docApi(ROAM)}/permissions`, { scripts: true });
    assertEq(grant.status, 200, "roam.html grant POST status");

    await rename(docPath(home.ws, ROAM), docPath(home.ws, MOVED));
    const moved = await docInfo(MOVED);
    assertEq(moved.cls, "foreign", "classification after rename");
    assertEq(
      moved.permissions?.scripts,
      false,
      "scripts must be void after rename (the new address has no grant)",
    );
    assertEq(moved.trust, "off", "trust after rename");

    await rename(docPath(home.ws, MOVED), docPath(home.ws, ROAM));
    const back = await docInfo(ROAM);
    assertEq(
      back.permissions?.scripts,
      true,
      "the grant should come back once the path is restored (same-path recreation keeps it)",
    );
  });

  test("should adopt the file as *.hr.html via hr import with the original bytes unchanged", async () => {
    const out = await hr(["import", DOC, "--workspace", home.ws, "--json"], { cwd: home.ws });
    assertEq(out.code, 0, `hr import exit code (stderr: ${out.stderr.slice(0, 300)})`);
    const data = dataOf(out, "hr import");
    const imported = [data["path"], data["file"], data["out"]].find(
      (v): v is string => typeof v === "string",
    );
    assert(
      imported?.endsWith(".hr.html") === true,
      `import output path is not *.hr.html: ${JSON.stringify(data)}`,
    );
    const originalBytes = sha256File(await readFile(docPath(home.ws, DOC)));
    assertEq(originalBytes, originalSha, "the original file's bytes changed after import");
    const managed = await hr(["check", imported, "--workspace", home.ws, "--json"], {
      cwd: home.ws,
    });
    assertEq(managed.code, 0, "check exit code on the import output");
    const cls = dataOf(managed, "check import output")["cls"];
    assertIncludes(String(cls), "managed", "import output classification");
  });
});
