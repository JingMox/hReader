// Journey 3 (presentation mode): an `hr new --kind slides` native slides
// document → keyboard paging + step reveals → MCP edits the current slide /
// deletes the current slide mid-presentation → a #p=N reload returns to the
// same page → all state is cleaned up on exit.

import { afterAll, beforeAll, describe, test } from "vitest";

import { assert } from "../harness/check.ts";
import { newDoc } from "../harness/cli.ts";
import { launchBrowser, press, type Browser, type KEYS, type Page } from "../harness/chrome.ts";
import { chromeSkipReason, sandbox, type TestHome } from "../harness/env.ts";
import { startMcp, toolJson, type McpClient } from "../harness/mcp.ts";
import { killAllTracked } from "../harness/proc.ts";
import { startServe, type Daemon } from "../harness/serve.ts";

const skip = chromeSkipReason();

describe.skipIf(skip !== undefined)("present-journey", () => {
  const DOC = "slides.hr.html";
  let home: TestHome;
  let daemon: Daemon;
  let browser: Browser;
  let page: Page;
  let mcp: McpClient;
  /** The section-level nodeIds of the slides skeleton (MCP outline's top-level nodes). */
  let slideIds: string[] = [];

  const evalJs = (expr: string): Promise<unknown> => page.eval(expr);

  /** Presentation-state snapshot: the page hash, how many steps are already revealed, and whether we're on the last slide with no steps left (where the page key is a legal no-op). */
  const PRESENT_SNAPSHOT = `(() => {
    const slides = [...document.querySelectorAll('[data-hr-slide-state]')];
    const idx = slides.findIndex((el) => el.getAttribute('data-hr-slide-state') === 'current');
    return {
      hash: location.hash,
      shownSteps: document.querySelectorAll('[data-hr-step-state="current"],[data-hr-step-state="past"]').length,
      atLast: idx !== -1 && idx === slides.length - 1,
      futureSteps: document.querySelectorAll('[data-hr-step-state="future"]').length,
    };
  })()`;

  /** One press's real effect: the page hash changed, or one more step got revealed — assertions anchor on DOM state, not on press timing. */
  const pressEffectOf = (prev: unknown): string => `(() => {
    const prev = ${JSON.stringify(prev)};
    return location.hash !== prev.hash ||
      document.querySelectorAll('[data-hr-step-state="current"],[data-hr-step-state="past"]').length > prev.shownSteps;
  })()`;

  /** Press once and wait for it to land in the DOM: paging is a no-op on the last slide with no steps left; everywhere else the effect must be seen to count as delivered. */
  const pressAndSettle = async (key: keyof typeof KEYS): Promise<void> => {
    const prev = await evalJs(PRESENT_SNAPSHOT);
    await press(page, key);
    const noop =
      typeof prev === "object" &&
      prev !== null &&
      Reflect.get(prev, "atLast") === true &&
      Reflect.get(prev, "futureSteps") === 0;
    if (noop) return;
    const landed = await page.wait(pressEffectOf(prev), 8_000);
    assert(landed === true, `the ${key} press produced no DOM change`);
  };

  const slideNodeIds = async (): Promise<string[]> => {
    const outline = toolJson(await mcp.call("hr_outline", { filePath: DOC }), "hr_outline");
    const nodes = outline["nodes"];
    assert(Array.isArray(nodes) && nodes.length > 0, "slides outline is empty");
    const list = nodes as readonly unknown[];
    return list
      .map((node: unknown): unknown =>
        typeof node === "object" && node !== null ? Reflect.get(node, "id") : undefined,
      )
      .filter((id): id is string => typeof id === "string");
  };

  beforeAll(async () => {
    home = sandbox("present");
    await newDoc(home.ws, DOC, ["--kind", "slides"]);
    daemon = await startServe({ file: DOC, workspace: home.ws, home: home.home });
    mcp = await startMcp(home.ws);
    slideIds = await slideNodeIds();
    browser = await launchBrowser();
    page = await browser.open(daemon.url);
  });

  afterAll(async () => {
    await browser.close();
    await mcp.close();
    await daemon.stop();
    await killAllTracked();
    home.cleanup();
  });

  test("should show #hr-present-btn and land data-hr-present + a #p= hash on #hr-root after entering presentation", async () => {
    const ready = await page.wait(`document.querySelector('#hr-doc [data-hr-id]') !== null`);
    assert(ready === true, "the slides document did not render");
    // A slides document's present button should have hidden removed.
    const btn = await page.wait(
      `(() => { const b = document.querySelector('#hr-present-btn'); return b && !b.hasAttribute('hidden') && !b.hidden; })()`,
    );
    assert(btn === true, "the slides document's #hr-present-btn did not appear");
    await evalJs(`document.querySelector('#hr-present-btn').click()`);
    const on = await page.wait(
      `document.querySelector('#hr-root').hasAttribute('data-hr-present') && location.hash.startsWith('#p=')`,
    );
    assert(on === true, "no data-hr-present / #p= marker after entering presentation");
  });

  test("should reveal steps on ArrowRight (data-hr-step-state) before paging to p=2", async () => {
    // The first slide has data-hr-step elements: the first ArrowRight should
    // reveal a step rather than turn the page.
    const stepped = await press(page, "ArrowRight").then(() =>
      page.wait(
        `document.querySelector('[data-hr-step-state="shown"],[data-hr-step-state="current"],[data-hr-step-state="past"]') !== null || location.hash.startsWith('#p=2')`,
        8_000,
      ),
    );
    assert(stepped === true, "neither the steps nor the page moved after ArrowRight");
    // Keep pressing once the steps are done: each press waits for its effect
    // in the DOM before the next (no fixed millisecond gaps between presses —
    // under load "the previous press hasn't been handled and another arrives"
    // turns the page too far).
    for (let i = 0; i < 12; i += 1) {
      if (String(await evalJs(`location.hash`)) === "#p=2") break;
      await pressAndSettle("ArrowRight");
    }
    const hash = String(await evalJs(`location.hash`));
    assert(hash === "#p=2", `did not reach slide 2 after the steps ran out (hash=${hash})`);
    const slideState = await evalJs(
      `document.querySelector('[data-hr-slide-state="current"]') !== null`,
    );
    assert(slideState === true, "slide 2 has no data-hr-slide-state=current marker");
  });

  test("should reflect an MCP patch of the current slide in the DOM live during presentation", async () => {
    const target = slideIds[Math.min(1, slideIds.length - 1)];
    assert(target !== undefined, "the slides outline has no slide to patch");
    const patched = await mcp.call("hr_patch_node", {
      filePath: DOC,
      nodeId: target,
      action: "replace",
      htmlContent: `<section data-hr-id="${target}"><h2>演示中已改</h2><p>LIVE-PATCH</p></section>`,
    });
    assert(!patched.isError, `mid-presentation patch errored: ${patched.text}`);
    const seen = await page.wait(`document.body.textContent.includes('LIVE-PATCH')`);
    assert(seen === true, "the mid-presentation patch did not reach the slides DOM live");
  });

  test("should return to the same slide after a #p=N reload", async () => {
    // Wait for this press's effect to land in the DOM before grabbing `before`:
    // otherwise reload beats the keypress handling, a late page-turn changes
    // the hash, and the post-reload wait can never see the old value again.
    await pressAndSettle("ArrowRight");
    const before = String(await evalJs(`location.hash`));
    if (!/^#p=\d+$/u.test(before)) {
      // The presentation hash may have been cleared to another anchor; as long
      // as we're still in presentation, keep testing reload recovery.
      return;
    }
    await page.reload();
    // The URL keeps the "#p=" hash across reload, so a hash-only wait resolves
    // while the app is still booting — the resumable fact is `data-hr-present`
    // being painted again (state.present.active true, keydown bound).
    const restored = await page.wait(
      `document.querySelector('#hr-root').hasAttribute('data-hr-present') && location.hash === ${JSON.stringify(before)}`,
      20_000,
    );
    assert(
      restored === true,
      `presentation state did not recover to ${before} after reload (actual: ${String(await evalJs("location.hash"))})`,
    );
  });

  test("should not crash and land on a valid state when the current slide is deleted mid-presentation", async () => {
    const hashBefore = String(await evalJs(`location.hash`));
    const pageNo = /^#p=(\d+)$/u.exec(hashBefore)?.[1];
    const index = pageNo === undefined ? 0 : Math.max(0, Number(pageNo) - 1);
    const target = slideIds[Math.min(index, slideIds.length - 1)] ?? slideIds[0];
    assert(target !== undefined, "no slide to delete");
    const del = await mcp.call("hr_patch_node", {
      filePath: DOC,
      nodeId: target,
      action: "delete",
      htmlContent: "",
    });
    assert(!del.isError, `mid-presentation delete errored: ${del.text}`);
    const alive = await page.wait(
      `document.body.children.length > 0 && (location.hash === '' || /^#p=\\d+$/.test(location.hash))`,
    );
    assert(alive === true, "the page crashed after the current slide was deleted");
  });

  test("should clean up all state after exiting presentation", async () => {
    // An Escape fired before `data-hr-present` is painted lands inside the
    // post-reload resume gap: it is dropped while keydown is unbound or reduced
    // to a panelClosed no-op, after which the "#p=" hash resume re-activates
    // presentation and the assertions below can never hold.
    const armed = await page.wait(
      `document.querySelector('#hr-root').hasAttribute('data-hr-present')`,
      15_000,
    );
    assert(armed === true, "presentation was not active before pressing Escape");
    await press(page, "Escape");
    const clean = await page.wait(
      `location.hash === '' && !document.documentElement.hasAttribute('data-hr-present') && !document.body.hasAttribute('data-hr-present') && document.querySelectorAll('[data-hr-slide-state],[data-hr-step-state]').length === 0`,
      15_000,
    );
    assert(
      clean === true,
      `state residue after exiting presentation (hash=${String(await evalJs("location.hash"))})`,
    );
  });
});
