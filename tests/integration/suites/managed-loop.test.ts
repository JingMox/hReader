// 旅程 1（托管文档全闭环）：hr new → hr serve → 真 Chrome 打开阅读器 → MCP patch 经 SSE 实时刷新 →
// 阅读器划词批注 → agent 经 MCP 读批注/patch/resolve → 多次 undo 回到初始字节；
// 中途外部编辑器直写与"写临时文件再 rename"两种改法。
// 变体：乱序（undo 在任何写之前、patch 已删块、resolve 不存在的批注）与中断（SIGTERM/SIGINT 后恢复）。

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, test } from "vitest";

import { assert, assertEq, assertIncludes } from "../harness/check.ts";
import { docPath, errorOf, hr, newDoc, type JsonObject } from "../harness/cli.ts";
import { launchBrowser, type Browser, type Page } from "../harness/chrome.ts";
import { chromeSkipReason, sandbox, sha256File, until, type TestHome } from "../harness/env.ts";
import { connect, type Api } from "../harness/http.ts";
import { startMcp, toolJson, type McpClient } from "../harness/mcp.ts";
import { killAllTracked, portClosed } from "../harness/proc.ts";
import { startServe, daemonFileExists, type Daemon } from "../harness/serve.ts";

const skip = chromeSkipReason();
describe.skipIf(skip !== undefined)("managed-loop", () => {
  const DOC = "doc.hr.html";
  let home: TestHome;
  let daemon: Daemon;
  let api: Api;
  let browser: Browser;
  let page: Page;
  let mcp: McpClient;
  let initialSha = "";

  const textOf = (selector: string): Promise<unknown> =>
    page.eval(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.textContent : null; })()`,
    );

  /** 第一个正文块的 data-hr-id（hr new 骨架里 <h1> 也有 id，取 section 里第一个 p 更稳）。 */
  const firstBlockId = async (): Promise<string> => {
    const outline = toolJson(await mcp.call("hr_outline", { filePath: DOC }), "hr_outline");
    const nodes = outline["nodes"];
    assert(Array.isArray(nodes) && nodes.length > 0, "hr_outline 返回空大纲");
    const first = nodes[0] as JsonObject;
    const id = first["id"];
    assert(typeof id === "string" && id !== "", "hr_outline 首节点没有 id");
    return id;
  };

  beforeAll(async () => {
    home = sandbox("managed");
    await newDoc(home.ws, DOC);
    initialSha = sha256File(await readFile(docPath(home.ws, DOC)));
    daemon = await startServe({ file: DOC, workspace: home.ws, home: home.home });
    api = await connect(daemon.port, daemon.token);
    mcp = await startMcp(home.ws);
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

  test("阅读器渲染托管文档（块 + 目录 + 状态栏）", async () => {
    const ready = await page.wait(`document.querySelector('#hr-doc [data-hr-id]') !== null`);
    assert(ready !== false, "阅读器 20s 内没有渲染出任何 data-hr-id 块");
    const conn = await page.wait(
      `(() => { const el = document.querySelector('#hr-conn'); return el && el.textContent !== '' ? el.textContent : false; })()`,
    );
    assertIncludes(String(conn), "已同步", "状态栏连接态");
  });

  test("MCP hr_patch_node 落盘，SSE 推 doc.changed，阅读器实时刷新", async () => {
    const sse = await api.openSse();
    const nodeId = await firstBlockId();
    const patch = await mcp.call("hr_patch_node", {
      filePath: DOC,
      nodeId,
      action: "replace",
      htmlContent: `<h2 data-hr-id="${nodeId}">MCP-刷新标记</h2>`,
    });
    assert(!patch.isError, `hr_patch_node 报错：${patch.text}`);
    const event = await sse.next("doc.changed");
    sse.close();
    assert(event !== undefined, "MCP patch 后 SSE 没推 doc.changed");
    const seen = await page.wait(
      `document.querySelector('#hr-doc').textContent.includes('MCP-刷新标记')`,
    );
    assert(seen === true, "MCP patch 后阅读器 DOM 没有经 SSE 更新");
  });

  test("划词批注 → agent 经 MCP 闭环（outline 读到 → patch → resolve）", async () => {
    // 真实划词：在第一个正文块的文本节点上造 Range，再补一个 window mouseup（main.ts 的接线点）。
    const selected = await page.eval(`(() => {
      const block = document.querySelector('#hr-doc [data-hr-id] p, #hr-doc [data-hr-id] h1, #hr-doc [data-hr-id] h2');
      if (!block) return 'no-block';
      const textNode = block.firstChild && block.firstChild.nodeType === 3 ? block.firstChild : null;
      if (!textNode || (textNode.textContent ?? '').trim() === '') return 'no-text';
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, Math.min(4, textNode.textContent.length));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return { node: textNode.parentElement.closest('[data-hr-id]').getAttribute('data-hr-id') };
    })()`);
    assert(
      typeof selected === "object" && selected !== null,
      `划词失败：${JSON.stringify(selected)}`,
    );
    const btnReady = await page.wait(
      `(() => { const el = document.querySelector('#hr-note-btn'); return el && !el.hidden; })()`,
    );
    assert(btnReady === true, "选区之后“批注选区”按钮没有亮出");
    await page.click("#hr-note-btn");
    const typed = await page.eval(`(() => {
      const draft = document.querySelector('#hr-note-draft');
      draft.value = 'MCP 闭环批注';
      draft.dispatchEvent(new Event('input', { bubbles: true }));
      return draft.value;
    })()`);
    assertEq(typed, "MCP 闭环批注", "批注草稿");
    await page.click("#hr-note-submit");
    // 右栏先出乐观卡、POST 完了才落真卡：断言盯服务端真相——轮询 outline 的 pendingAnnotations。
    const outline = await until(
      async () => toolJson(await mcp.call("hr_outline", { filePath: DOC }), "hr_outline(批注)"),
      (value) => {
        const p = value["pendingAnnotations"];
        return Array.isArray(p) && p.length === 1;
      },
      { timeoutMs: 10_000 },
    );
    const pending = outline["pendingAnnotations"];
    assert(
      Array.isArray(pending) && pending.length === 1,
      `agent 侧读到的待处理批注数异常：${JSON.stringify(outline).slice(0, 400)}`,
    );
    const card = await page.wait(
      `document.querySelector('#hr-notes-pending [data-hr-annotation]') !== null`,
    );
    assert(card === true, "批注提交后未处理列表里没有卡片");
    const annotation = pending[0] as JsonObject;
    assertIncludes(String(annotation["comment"]), "MCP 闭环批注", "批注内容");
    const targetId = annotation["targetId"];
    const anId = annotation["id"];
    assert(typeof targetId === "string" && typeof anId === "string", "批注缺 targetId/id");

    const fixed = await mcp.call("hr_patch_node", {
      filePath: DOC,
      nodeId: targetId,
      action: "replace",
      htmlContent: `<p data-hr-id="${targetId}">已按批注修订。</p>`,
    });
    assert(!fixed.isError, `按批注 patch 失败：${fixed.text}`);
    const resolved = await mcp.call("hr_resolve_annotation", {
      filePath: DOC,
      annotationId: anId,
      resolutionNote: "已修订该段",
    });
    assert(!resolved.isError, `hr_resolve_annotation 报错：${resolved.text}`);
    const after = toolJson(await mcp.call("hr_outline", { filePath: DOC }), "hr_outline(结后)");
    assertEq(JSON.stringify(after["pendingAnnotations"]), "[]", "resolve 后仍有待处理批注");
    const archived = await page.wait(
      `document.querySelector('#hr-notes-resolved [data-hr-annotation]') !== null`,
    );
    assert(archived === true, "resolve 后右栏没有出现已归档卡片");
  });

  test("乱序：undo 先于任何写、patch 已删节点、resolve 不存在的批注", async () => {
    const ws2 = sandbox("managed-oos");
    try {
      await newDoc(ws2.ws, "fresh.hr.html");
      const undo = await hr(["undo", "fresh.hr.html", "--workspace", ws2.ws, "--json"], {
        cwd: ws2.ws,
      });
      assertEq(undo.code, 1, "空历史 undo 退出码");
      assertEq(errorOf(undo, "空历史 undo").code, "nothing_to_undo", "空历史 undo 错误码");

      await newDoc(ws2.ws, "victim.hr.html");
      const victimHtml = await readFile(docPath(ws2.ws, "victim.hr.html"), "utf8");
      // 文件里第一个 data-hr-id 是容器（article/root，不许删）；取最后一个叶子块。
      const allIds = [...victimHtml.matchAll(/data-hr-id="([^"]+)"/gu)].map((m) => m[1]);
      const target = allIds.at(-1);
      assert(target !== undefined, "hr new 骨架里没有 data-hr-id");
      const removed = await hr(
        ["patch", "victim.hr.html", target, "--action", "delete", "--workspace", ws2.ws, "--json"],
        { cwd: ws2.ws },
      );
      assertEq(removed.code, 0, "删除首个块退出码");
      const again = await hr(
        ["patch", "victim.hr.html", target, "--action", "delete", "--workspace", ws2.ws, "--json"],
        { cwd: ws2.ws },
      );
      assertEq(errorOf(again, "patch 已删节点").code, "node_not_found", "patch 已删节点错误码");

      const bogus = await mcp.call("hr_resolve_annotation", {
        filePath: DOC,
        annotationId: "an_deadbeef",
      });
      assert(bogus.isError, "resolve 不存在的批注竟然成功");
    } finally {
      ws2.cleanup();
    }
  });

  test("外部编辑器直写与 tmp+rename 两种改法都经 watcher/SSE 刷新", async () => {
    const path = docPath(home.ws, DOC);
    const before = await readFile(path, "utf8");
    // 往首个 <p data-hr-id> 块里注入文本：无 id 的新节点进不了块级 diff。
    const injected = before.replace(/(<p data-hr-id="[^"]+">)/u, "$1外部直写标记 EXT-DIRECT ");
    assert(injected !== before, "直写注入点没找到");
    await writeFile(path, injected, "utf8");
    const direct = await page.wait(
      `document.querySelector('#hr-doc').textContent.includes('EXT-DIRECT')`,
    );
    assert(direct === true, "外部直写没有经 watcher/SSE 刷到阅读器");

    const staged = injected.replace("EXT-DIRECT", "RENAME-替换标记");
    const tmp = join(home.ws, `.swap-${String(process.pid)}.tmp`);
    await writeFile(tmp, staged, "utf8");
    await rename(tmp, path);
    const swapped = await page.wait(
      `document.querySelector('#hr-doc').textContent.includes('RENAME-替换标记')`,
    );
    assert(swapped === true, "tmp+rename 改写没有经 watcher/SSE 刷到阅读器");
  });

  test("连续 undo 回到 hr new 的初始字节", async () => {
    for (let i = 0; i < 15; i += 1) {
      const undo = await hr(["undo", DOC, "--workspace", home.ws, "--json"], { cwd: home.ws });
      if (undo.code !== 0) {
        assertEq(errorOf(undo, "undo 到底").code, "nothing_to_undo", "undo 耗尽时的错误码");
        break;
      }
      assert(i < 14, "undo 15 次仍未耗尽快照链（历史裁剪应 ≤10）");
    }
    const finalSha = sha256File(await readFile(docPath(home.ws, DOC)));
    assertEq(finalSha, initialSha, "undo 到底后的文档 sha（应等于 hr new 初始字节）");
    const seen = await page.wait(`document.querySelector('#hr-doc').textContent.includes('要点')`);
    assert(seen === true, "undo 回到初始后阅读器没有同步回来");
  });

  test("中断：SIGTERM 后阅读器转入重连，daemon 重启可恢复", async () => {
    const code = await daemon.stop();
    assert(code === 0 || code === null, `SIGTERM 后退出码异常：${String(code)}`);
    assert(!daemonFileExists(daemon.home), "SIGTERM 后 daemon.json 没清掉");
    const conn = await page.wait(
      `(() => { const el = document.querySelector('#hr-conn'); return el && /重连|离线/.test(el.textContent) ? el.textContent : false; })()`,
      25_000,
    );
    assert(
      conn !== false,
      `断线后状态栏没有转入重连/离线（当前：${String(await textOf("#hr-conn"))}）`,
    );

    // 新 daemon 是新端口+新 token：旧页面那条 SSE 永远回不来——降级态是终点。
    // 恢复路径 = 用新 daemon 的 url 重开（等价于用户重新打开链接）。
    daemon = await startServe({ file: DOC, workspace: home.ws, home: home.home });
    api = await connect(daemon.port, daemon.token);
    await page.navigate(daemon.url);
    const again = await page.wait(`document.querySelector('#hr-doc [data-hr-id]') !== null`);
    assert(again === true, "daemon 重启 + 重新打开后阅读器没有恢复");
    const conn2 = await page.wait(
      `(() => { const el = document.querySelector('#hr-conn'); return el && el.textContent.includes('已同步') ? el.textContent : false; })()`,
      20_000,
    );
    assert(conn2 !== false, "daemon 重启后状态栏没有回到已同步");
  });

  test("中断：SIGINT 与 SIGTERM 同样优雅（daemon.json 清掉、端口释放）", async () => {
    daemon.proc.kill("SIGINT");
    const code = await daemon.proc.exited;
    assert(code === 0 || code === null, `SIGINT 后退出码异常：${String(code)}`);
    assert(!daemonFileExists(daemon.home), "SIGINT 后 daemon.json 没清掉");
    const closed = await until(
      () => portClosed(daemon.port),
      (v) => v,
    );
    assert(closed, `SIGINT 后端口 ${String(daemon.port)} 仍在监听`);
    const dead = await fetch(`http://127.0.0.1:${String(daemon.port)}/healthz`).then(
      () => false,
      () => true,
    );
    assert(dead, "SIGINT 后 healthz 仍通");
  });
});
