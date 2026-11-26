// Version journey: hr new → hr serve → real Chrome opens the reader → the status bar
// must show the version from `packages/app/package.json`. The unit test pins the src-side
// value; this journey pins the whole chain — build-time bake in build-static.mjs, static
// hosting, browser render — so a broken bake step only goes red here.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, test } from "vitest";

import { assert, assertEq } from "../harness/check.ts";
import { newDoc } from "../harness/cli.ts";
import { launchBrowser, type Browser, type Page } from "../harness/chrome.ts";
import { chromeSkipReason, sandbox, type TestHome } from "../harness/env.ts";
import { killAllTracked } from "../harness/proc.ts";
import { startServe, type Daemon } from "../harness/serve.ts";

const { version } = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../packages/app/package.json"), "utf8"),
) as { readonly version: string };

const skip = chromeSkipReason();
describe.skipIf(skip !== undefined)("version-journey", () => {
  const DOC = "doc.hr.html";
  let home: TestHome;
  let daemon: Daemon;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    home = sandbox("version");
    await newDoc(home.ws, DOC);
    daemon = await startServe({ file: DOC, workspace: home.ws, home: home.home });
    browser = await launchBrowser();
    page = await browser.open(daemon.url);
  });

  afterAll(async () => {
    await browser.close();
    await daemon.stop();
    killAllTracked();
    home.cleanup();
  });

  test("status bar shows the package.json version", async () => {
    const shown = await page.wait(
      `(() => { const el = document.querySelector('#hr-version'); return el && el.textContent !== '' ? el.textContent : false; })()`,
    );
    assertEq(shown, `v${version}`, "#hr-version text");
  });

  test("reader loads with no console errors or failed requests", async () => {
    // A broken module emit (a stray node: import, a missing chunk) shows up here even
    // when the page still renders — this is the browser-side mirror of the dist audit.
    const ready = await page.wait(`document.querySelector('#hr-doc') !== null`);
    assert(ready !== false, "reader did not render #hr-doc within 20s");
    // favicon.ico 404s on every load (the server ships no icon) — pre-existing, not a
    // module failure; everything else must be clean.
    const errors = page.consoleErrors().filter((entry) => !entry.includes("favicon.ico"));
    assert(errors.length === 0, `console errors / failed requests: ${JSON.stringify(errors)}`);
  });
});
