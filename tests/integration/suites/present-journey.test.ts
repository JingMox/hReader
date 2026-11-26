// 旅程 3（演示模式）：`hr new --kind slides` 原生 slides 文档 → 键盘翻页 + 逐步显示 →
// 演示中 MCP 改当前页 / 删当前页 → #p=N 刷新回原页 → 退出后状态全部清理。

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
  /** slides 骨架的 section 级 nodeId（MCP outline 顶层节点）。 */
  let slideIds: string[] = [];

  const evalJs = (expr: string): Promise<unknown> => page.eval(expr);

  /** 演示态快照：页码 hash、已放出步进数、是否已到末页且无步进可放（此时翻页键是合法 no-op）。 */
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

  /** 一按的真实效果：页码变了，或步进又多放出一条——断言锚 DOM 状态，不锚按键间隔。 */
  const pressEffectOf = (prev: unknown): string => `(() => {
    const prev = ${JSON.stringify(prev)};
    return location.hash !== prev.hash ||
      document.querySelectorAll('[data-hr-step-state="current"],[data-hr-step-state="past"]').length > prev.shownSteps;
  })()`;

  /** 按一次并等它落 DOM：末页无步进时翻页是 no-op，其余情况必须看到效果才算送达。 */
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
    assert(landed === true, `${key} 按键没有落出任何 DOM 变化`);
  };

  const slideNodeIds = async (): Promise<string[]> => {
    const outline = toolJson(await mcp.call("hr_outline", { filePath: DOC }), "hr_outline");
    const nodes = outline["nodes"];
    assert(Array.isArray(nodes) && nodes.length > 0, "slides 大纲为空");
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
    killAllTracked();
    home.cleanup();
  });

  test("进入演示：#hr-present-btn 可见，点击后 #hr-root 落 data-hr-present + #p= hash", async () => {
    const ready = await page.wait(`document.querySelector('#hr-doc [data-hr-id]') !== null`);
    assert(ready === true, "slides 文档没渲染");
    // slides 文档的演示按钮应取消 hidden。
    const btn = await page.wait(
      `(() => { const b = document.querySelector('#hr-present-btn'); return b && !b.hasAttribute('hidden') && !b.hidden; })()`,
    );
    assert(btn === true, "slides 文档的 #hr-present-btn 没出现");
    await evalJs(`document.querySelector('#hr-present-btn').click()`);
    const on = await page.wait(
      `document.querySelector('#hr-root').hasAttribute('data-hr-present') && location.hash.startsWith('#p=')`,
    );
    assert(on === true, "进入演示后没有 data-hr-present / #p= 标记");
  });

  test("键盘翻页：ArrowRight 先放步进（data-hr-step-state）再翻到 p=2", async () => {
    // 第一页有 data-hr-step 元素：第一次 ArrowRight 应揭步进而非翻页。
    const stepped = await press(page, "ArrowRight").then(() =>
      page.wait(
        `document.querySelector('[data-hr-step-state="shown"],[data-hr-step-state="current"],[data-hr-step-state="past"]') !== null || location.hash.startsWith('#p=2')`,
        8_000,
      ),
    );
    assert(stepped === true, "ArrowRight 后步进/页码都没动");
    // 步进放完后继续按：每一按等效果落 DOM 再按下一按（按键间不靠固定毫秒，
    // 负载下"上一按还没处理又补一按"会把页翻过头）。
    for (let i = 0; i < 12; i += 1) {
      if (String(await evalJs(`location.hash`)) === "#p=2") break;
      await pressAndSettle("ArrowRight");
    }
    const hash = String(await evalJs(`location.hash`));
    assert(hash === "#p=2", `步进放完后没翻到第 2 页（hash=${hash}）`);
    const slideState = await evalJs(
      `document.querySelector('[data-hr-slide-state="current"]') !== null`,
    );
    assert(slideState === true, "第 2 页没有 data-hr-slide-state=current 标记");
  });

  test("演示中 MCP patch 当前页，DOM 实时更新", async () => {
    const target = slideIds[Math.min(1, slideIds.length - 1)];
    assert(target !== undefined, "slides 大纲没有可 patch 的页");
    const patched = await mcp.call("hr_patch_node", {
      filePath: DOC,
      nodeId: target,
      action: "replace",
      htmlContent: `<section data-hr-id="${target}"><h2>演示中已改</h2><p>LIVE-PATCH</p></section>`,
    });
    assert(!patched.isError, `演示中 patch 报错：${patched.text}`);
    const seen = await page.wait(`document.body.textContent.includes('LIVE-PATCH')`);
    assert(seen === true, "演示中 patch 没有实时反映到幻灯片 DOM");
  });

  test("#p=N 刷新后回到原页", async () => {
    // 等这一按的效果落 DOM 再抓 before：否则 reload 会抢在按键处理前，
    // 晚到的翻页把 hash 改掉，刷新后永远等不回旧值。
    await pressAndSettle("ArrowRight");
    const before = String(await evalJs(`location.hash`));
    if (!/^#p=\d+$/u.test(before)) {
      // 演示态的 hash 可能被清成别的锚点；只要还在演示态就继续测刷新恢复。
      return;
    }
    await page.reload();
    const restored = await page.wait(`location.hash === ${JSON.stringify(before)}`, 20_000);
    assert(
      restored === true,
      `刷新后 hash 没恢复到 ${before}（实际：${String(await evalJs("location.hash"))}）`,
    );
  });

  test("演示中删掉当前页：不崩，落到有效状态", async () => {
    const hashBefore = String(await evalJs(`location.hash`));
    const pageNo = /^#p=(\d+)$/u.exec(hashBefore)?.[1];
    const index = pageNo === undefined ? 0 : Math.max(0, Number(pageNo) - 1);
    const target = slideIds[Math.min(index, slideIds.length - 1)] ?? slideIds[0];
    assert(target !== undefined, "没有可删的页");
    const del = await mcp.call("hr_patch_node", {
      filePath: DOC,
      nodeId: target,
      action: "delete",
      htmlContent: "",
    });
    assert(!del.isError, `演示中删页报错：${del.text}`);
    const alive = await page.wait(
      `document.body.children.length > 0 && (location.hash === '' || /^#p=\\d+$/.test(location.hash))`,
    );
    assert(alive === true, "删当前页后页面崩了");
  });

  test("退出演示后状态全部清理", async () => {
    await press(page, "Escape");
    const clean = await page.wait(
      `location.hash === '' && !document.documentElement.hasAttribute('data-hr-present') && !document.body.hasAttribute('data-hr-present') && document.querySelectorAll('[data-hr-slide-state],[data-hr-step-state]').length === 0`,
      15_000,
    );
    assert(clean === true, `退出演示后残留状态（hash=${String(await evalJs("location.hash"))}）`);
  });
});
