// 旅程 2（外来 HTML 全闭环）：JS 驱动动画演示稿放进工作区 → 阅读器只读横幅 → 点"允许运行脚本"授信
// local 档、脚本真跑（allow-scripts 下 iframe 是 opaque origin，脚本活性用 postMessage 探针）→
// 阅读器切主题（页内 0-token，允许）+ /api/style 写盘（<style id="hr-theme"> 进文件）→
// sha 变化信任失效（钉住预期行为：info 回 off、脚本被 CSP 掐死、不白屏）→
// undo 回原字节 → 原 sha 信任恢复、脚本复活 → `hr import` 收编为 *.hr.html。

import { readFile, writeFile } from "node:fs/promises";

import { afterAll, beforeAll, describe, test } from "vitest";

import { assert, assertEq, assertIncludes } from "../harness/check.ts";
import { dataOf, docPath, hr } from "../harness/cli.ts";
import { launchBrowser, type Browser, type Page } from "../harness/chrome.ts";
import { chromeSkipReason, sandbox, sha256File, type TestHome } from "../harness/env.ts";
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

describe.skipIf(skip !== undefined)("foreign-journey", () => {
  const DOC = "deck.html";
  let home: TestHome;
  let daemon: Daemon;
  let api: Api;
  let browser: Browser;
  let page: Page;
  let originalSha = "";

  const docInfo = async (): Promise<{ trust?: unknown; cls?: unknown }> =>
    await api.getJson(`${docApi(DOC)}/info`);

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

  test("外来文档：trust=off + 只读横幅 + sandbox 全限制，脚本不跑", async () => {
    const info = await docInfo();
    assertEq(info.trust, "off", "外来文档初始 trust");
    assertEq(info.cls, "foreign", "外来文档分类");
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

  test("点'允许运行脚本'授信 local：sandbox=allow-scripts，脚本真跑", async () => {
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
    assertEq(info.trust, "local", "授信 local 后 trust");
    const ran = await page.wait(
      `Array.isArray(window.__foreignMsgs) && window.__foreignMsgs.length > 0`,
      15_000,
    );
    assert(ran === true, "授信 local 后 iframe 里脚本没有心跳");
  });

  test("写盘（/api/style）→ sha 变、trust 失效、脚本被掐、不白屏", async () => {
    // 钉住 framed 模式的实际行为：外来文档的主题选择器没有接 themes 清单（页内 0-token
    // 切换是托管文档的路径）——控件存在但没有选项，切主题对外来文档无入口。
    const themeCtl = await page.eval(`(() => {
      const sel = document.querySelector('#hr-theme-select');
      return sel ? { options: sel.options.length, disabled: sel.disabled } : 'absent';
    })()`);
    assert(
      themeCtl === "absent" ||
        (typeof themeCtl === "object" &&
          themeCtl !== null &&
          Reflect.get(themeCtl, "options") === 0),
      `framed 模式主题选择器竟然可用：${JSON.stringify(themeCtl)}`,
    );

    // 写盘路径：/api/style 把 <style id="hr-theme"> 写进外来文档——sha 变、sha 键信任失效。
    const themes = await api.getJson("/api/theme");
    const ids = themes["themes"];
    assert(Array.isArray(ids) && ids.length > 0, "/api/theme 列表为空");
    const style = await api.post("/api/style", { docId: DOC, visualId: ids[0] });
    assertEq(style.status, 200, "外来文档 /api/style 状态");
    const off = await page.wait(
      `(async () => { const res = await fetch('/api/doc/${encodeURIComponent(DOC)}/info'); if (!res.ok) return false; const j = await res.json(); return j.trust === 'off'; })()`,
      15_000,
    );
    assert(off === true, "主题写盘后 trust 没有失效回 off");
    const themeWritten = (await readFile(docPath(home.ws, DOC), "utf8")).includes('id="hr-theme"');
    assert(themeWritten, "主题 <style id=hr-theme> 没有写进文件");
    // iframe 被 doc.changed 重载、服务端 CSP 按 off 档收口：心跳应停。
    const stopped = await page.wait(
      `new Promise(resolve => {
        const before = window.__foreignMsgs.length;
        setTimeout(() => resolve(window.__foreignMsgs.length === before), 900);
      })`,
      15_000,
    );
    assert(stopped === true, "trust 失效后外来脚本仍在跑（心跳未停）");
    const alive = await page.eval(
      `document.body.children.length > 0 && !document.querySelector('#hr-foreign').hidden`,
    );
    assert(alive === true, "信任失效后页面白屏/横幅丢失");
  });

  test("undo 回到原字节后，原 sha 的信任自动恢复（脚本复活）", async () => {
    const undo = await hr(["undo", DOC, "--workspace", home.ws, "--json"], { cwd: home.ws });
    assertEq(undo.code, 0, "undo 主题写盘退出码");
    const restoredSha = sha256File(await readFile(docPath(home.ws, DOC)));
    assertEq(restoredSha, originalSha, "undo 后 sha 应回到外来文档原字节");
    const back = await page.wait(
      `(async () => { const res = await fetch('/api/doc/${encodeURIComponent(DOC)}/info'); if (!res.ok) return false; const j = await res.json(); return j.trust === 'local'; })()`,
      15_000,
    );
    assert(back === true, "undo 回原 sha 后 trust 没有恢复 local");
    // iframe 再重载：sandbox 仍是 allow-scripts + CSP 回到 local → 心跳恢复。
    const beatingAgain = await beating(1500);
    assert(beatingAgain, "信任恢复后外来脚本没有复活");
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
