// 旅程 2（外来 HTML 全闭环）：JS 驱动动画演示稿放进工作区 → 阅读器只读横幅 → 点"允许运行脚本"，
// 授权按路径键落盘（scripts 维单开）→ iframe allow-scripts、脚本真跑（opaque origin，活性靠
// postMessage 探针）→ 阅读器切主题（页内 0-token）+ /api/style 写盘 → **路径键授权不失效**，
// 心跳不停 → undo 回字节授权照样在（键不看内容）→ `hr import` 收编为 *.hr.html。
// 路径语义与全局模式的对抗面在 permissions-journey 里，这里只钉旅程主链。

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

// JS 驱动演示稿：postMessage 心跳是跨 opaque-origin 的唯一可观测通道。
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

  /** 探针计数：读 window.__foreignMsgs.length（监听器在页面加载后立即挂上）。 */
  const msgCount = async (): Promise<number> => {
    const value = await page.eval(
      `Array.isArray(window.__foreignMsgs) ? window.__foreignMsgs.length : -1`,
    );
    return typeof value === "number" ? value : -1;
  };

  /** 采样窗口内计数是否还在涨（脚本活性=心跳还在来）。 */
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
    // 先挂探针监听器再等首帧：错过早期心跳无所谓，后面只看增量。
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
    killAllTracked();
    home.cleanup();
  });

  test("外来文档：trust=off + permissions 两维全关 + 只读横幅 + sandbox 全限制，脚本不跑", async () => {
    const info = await docInfo();
    assertEq(info.trust, "off", "外来文档初始 trust");
    assertEq(info.cls, "foreign", "外来文档分类");
    assertEq(info.permissions?.scripts, false, "外来文档初始 scripts");
    assertEq(info.permissions?.network, false, "外来文档初始 network");
    assertEq(info.permissions?.scriptsSource, "doc", "初始 scripts 出处");
    const banner = await page.wait(
      `(() => { const el = document.querySelector('#hr-foreign'); return el && !el.hidden && el.textContent.includes('只读'); })()`,
      25_000,
    );
    assert(banner === true, "只读横幅没有出现");
    const sandboxAttr = await page.eval(
      `(() => { const f = document.querySelector('#hr-foreign-frame'); return f ? f.getAttribute('sandbox') : 'no-frame'; })()`,
    );
    assertEq(sandboxAttr, "", "off 档 sandbox 应为全限制空串");
    // "脚本没跑"只能靠窗口期无心跳证明：iframe 首载 + 心跳间隔都远小于窗口。
    assert(!(await beating(1200)), "trust=off 时外来脚本竟然有心跳");
  });

  test("点'允许运行脚本'：POST {scripts:true} → sandbox=allow-scripts，脚本真跑", async () => {
    const clicked = await page.eval(`(() => {
      const el = document.querySelector('#hr-foreign-action');
      if (!el) return false;
      el.click();
      return true;
    })()`);
    assert(clicked === true, "找不到授信按钮 #hr-foreign-action");
    const granted = await page.wait(
      `(() => { const f = document.querySelector('#hr-foreign-frame'); return f && f.getAttribute('sandbox') === 'allow-scripts'; })()`,
    );
    assert(granted === true, "授信后 sandbox 没有变成 allow-scripts");
    const info = await docInfo();
    assertEq(info.trust, "local", "授信后 trust（兼容字段=脚本生效）");
    assertEq(info.permissions?.scripts, true, "授信后 scripts");
    assertEq(info.permissions?.network, false, "授信后 network 仍关");
    const ran = await page.wait(
      `Array.isArray(window.__foreignMsgs) && window.__foreignMsgs.length > 0`,
      15_000,
    );
    assert(ran === true, "授信后 iframe 里脚本没有心跳");
  });

  test("写盘（/api/style）改字节：路径键授权不失效，trust 仍 local、心跳不停", async () => {
    // framed 模式的主题选择器接了 themes 清单，切换即写盘——和托管文档共用
    // /api/style 路径，与桌面端行为一致。钉住：选项非空、可交互、当前值在清单里。
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
      "/api/theme 列表为空",
    );
    assert(
      typeof themeCtl === "object" && themeCtl !== null,
      `framed 模式主题选择器缺席：${JSON.stringify(themeCtl)}`,
    );
    assert(
      Reflect.get(themeCtl, "options") === ids.length &&
        Reflect.get(themeCtl, "disabled") === false,
      `framed 模式主题选择器不可用：${JSON.stringify(themeCtl)}`,
    );
    const current: unknown = Reflect.get(themeCtl, "value");
    assert(
      typeof current === "string" && ids.includes(current),
      `选择器当前值不在主题清单里：${JSON.stringify(themeCtl)}`,
    );

    // 写盘路径：经选择器触发 /api/style——<style id="hr-theme"> 写进外来文档，
    // 内容变了但路径键授权按设计保留（本特性存在的意义）。
    const target = ids.find((id) => id !== current);
    assert(target !== undefined, "/api/theme 清单没有可切换的备选主题");
    const switched = await page.eval(`(() => {
      const sel = document.querySelector('#hr-theme-select');
      sel.value = ${JSON.stringify(target)};
      sel.dispatchEvent(new Event('change'));
      return sel.value;
    })()`);
    assertEq(switched, target, "选择器切换主题返回值");
    // 写盘是异步 fetch：轮询文件直到 <style id="hr-theme"> 落盘（不许用 sleep 硬等）。
    const fileNow = await until(
      async () => await readFile(docPath(home.ws, DOC), "utf8"),
      (text) => text.includes('id="hr-theme"'),
      { timeoutMs: 15_000 },
    );
    assert(fileNow.includes('id="hr-theme"'), "主题 <style id=hr-theme> 没有写进文件");

    // 路径键语义核心断言：sha 变了，授权不变。
    const info = await docInfo();
    assertEq(info.trust, "local", "写盘后 trust 必须仍是 local（路径键不看字节）");
    assertEq(info.permissions?.scripts, true, "写盘后 scripts 仍开");
    // 生效组合没变 → widget 不重载 iframe：心跳应当连续，不经历"先死再活"。
    assert(await beating(1500), "写盘后外来脚本心跳停了（组合没变不该重载）");
    const sandboxAttr = await page.eval(
      `document.querySelector('#hr-foreign-frame').getAttribute('sandbox')`,
    );
    assertEq(sandboxAttr, "allow-scripts", "写盘后 sandbox 应保持 allow-scripts");
  });

  test("undo 回到原字节：路径键授权与内容无关，仍然 local", async () => {
    const undo = await hr(["undo", DOC, "--workspace", home.ws, "--json"], { cwd: home.ws });
    assertEq(undo.code, 0, "undo 主题写盘退出码");
    const restoredSha = sha256File(await readFile(docPath(home.ws, DOC)));
    assertEq(restoredSha, originalSha, "undo 后 sha 应回到外来文档原字节");
    const info = await docInfo();
    assertEq(info.trust, "local", "undo 后 trust 仍应 local（与字节无关）");
    const beforeBeats = await msgCount();
    const beatingAgain = await page.wait(
      `Array.isArray(window.__foreignMsgs) && window.__foreignMsgs.length > ${String(beforeBeats)}`,
      15_000,
    );
    assert(beatingAgain === true, "undo 后外来脚本心跳没有恢复");
  });

  test("路径语义：改名即失效（新地址无授权），改回原路径授权恢复", async () => {
    const ROAM = "roam.html";
    const MOVED = "roam-moved.html";
    await writeFile(docPath(home.ws, ROAM), FOREIGN_HTML, "utf8");
    const grant = await api.post(`${docApi(ROAM)}/permissions`, { scripts: true });
    assertEq(grant.status, 200, "roam.html 授信退出码");

    await rename(docPath(home.ws, ROAM), docPath(home.ws, MOVED));
    const moved = await docInfo(MOVED);
    assertEq(moved.cls, "foreign", "改名后分类");
    assertEq(moved.permissions?.scripts, false, "改名后 scripts 必须失效（新地址无授权）");
    assertEq(moved.trust, "off", "改名后 trust");

    await rename(docPath(home.ws, MOVED), docPath(home.ws, ROAM));
    const back = await docInfo(ROAM);
    assertEq(back.permissions?.scripts, true, "路径复原后授权应回来（同径重建保留）");
  });

  test("hr import 收编为 *.hr.html：原文件字节不变，进入托管流程", async () => {
    const out = await hr(["import", DOC, "--workspace", home.ws, "--json"], { cwd: home.ws });
    assertEq(out.code, 0, `hr import 退出码（stderr: ${out.stderr.slice(0, 300)}）`);
    const data = dataOf(out, "hr import");
    const imported = [data["path"], data["file"], data["out"]].find(
      (v): v is string => typeof v === "string",
    );
    assert(
      imported?.endsWith(".hr.html") === true,
      `import 产物路径不是 *.hr.html：${JSON.stringify(data)}`,
    );
    const originalBytes = sha256File(await readFile(docPath(home.ws, DOC)));
    assertEq(originalBytes, originalSha, "import 后原文件字节变了");
    const managed = await hr(["check", imported, "--workspace", home.ws, "--json"], {
      cwd: home.ws,
    });
    assertEq(managed.code, 0, "import 产物 check 退出码");
    const cls = dataOf(managed, "check import 产物")["cls"];
    assertIncludes(String(cls), "managed", "import 产物分类");
  });
});
