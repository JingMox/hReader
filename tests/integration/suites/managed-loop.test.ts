// Journey 1 (managed document end-to-end): hr new → hr serve → real Chrome
// opens the reader → an MCP patch refreshes live over SSE → a reader
// highlight-annotation → the agent reads/patches/resolves it via MCP →
// repeated undos return to the initial bytes; midway, an external editor's
// direct write and a "write tmp file then rename" edit both go through.
// Variants: out-of-order (undo before any write, patch a deleted block,
// resolve a nonexistent annotation) and interruption (recovery after
// SIGTERM/SIGINT).

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

  /** The data-hr-id of the first body block (the <h1> in the hr new skeleton has an id too; the first p inside the section is more stable). */
  const firstBlockId = async (): Promise<string> => {
    const outline = toolJson(await mcp.call("hr_outline", { filePath: DOC }), "hr_outline");
    const nodes = outline["nodes"];
    assert(Array.isArray(nodes) && nodes.length > 0, "hr_outline returned an empty outline");
    const first = nodes[0] as JsonObject;
    const id = first["id"];
    assert(typeof id === "string" && id !== "", "hr_outline's first node has no id");
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

  test("should render the managed document in the reader (blocks + outline + status bar)", async () => {
    const ready = await page.wait(`document.querySelector('#hr-doc [data-hr-id]') !== null`);
    assert(ready !== false, "the reader rendered no data-hr-id block within 20s");
    const conn = await page.wait(
      `(() => { const el = document.querySelector('#hr-conn'); return el && el.textContent !== '' ? el.textContent : false; })()`,
    );
    assertIncludes(String(conn), "已同步", "status bar connection state");
  });

  test("should land an MCP hr_patch_node on disk, push doc.changed over SSE and refresh the reader live", async () => {
    const sse = await api.openSse();
    const nodeId = await firstBlockId();
    const patch = await mcp.call("hr_patch_node", {
      filePath: DOC,
      nodeId,
      action: "replace",
      htmlContent: `<h2 data-hr-id="${nodeId}">MCP-刷新标记</h2>`,
    });
    assert(!patch.isError, `hr_patch_node errored: ${patch.text}`);
    const event = await sse.next("doc.changed");
    sse.close();
    assert(event !== undefined, "SSE never pushed doc.changed after the MCP patch");
    const seen = await page.wait(
      `document.querySelector('#hr-doc').textContent.includes('MCP-刷新标记')`,
    );
    assert(seen === true, "the reader DOM did not update over SSE after the MCP patch");
  });

  test("should close the annotation loop via MCP (outline sees it → patch → resolve) when a passage is highlighted", async () => {
    // A real highlight: build a Range on the first body block's text node, then
    // fire a window mouseup (main.ts's wiring point).
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
      `highlight failed: ${JSON.stringify(selected)}`,
    );
    const btnReady = await page.wait(
      `(() => { const el = document.querySelector('#hr-note-btn'); return el && !el.hidden; })()`,
    );
    assert(btnReady === true, "the annotate-selection button did not appear after the selection");
    await page.click("#hr-note-btn");
    const typed = await page.eval(`(() => {
      const draft = document.querySelector('#hr-note-draft');
      draft.value = 'MCP 闭环批注';
      draft.dispatchEvent(new Event('input', { bubbles: true }));
      return draft.value;
    })()`);
    assertEq(typed, "MCP 闭环批注", "annotation draft");
    await page.click("#hr-note-submit");
    // The right rail shows an optimistic card first and only lands the real
    // card after the POST completes: assert on server truth — poll outline's
    // pendingAnnotations.
    const outline = await until(
      async () =>
        toolJson(await mcp.call("hr_outline", { filePath: DOC }), "hr_outline (annotation)"),
      (value) => {
        const p = value["pendingAnnotations"];
        return Array.isArray(p) && p.length === 1;
      },
      { timeoutMs: 10_000 },
    );
    const pending = outline["pendingAnnotations"];
    assert(
      Array.isArray(pending) && pending.length === 1,
      `pending annotation count read on the agent side is abnormal: ${JSON.stringify(outline).slice(0, 400)}`,
    );
    const card = await page.wait(
      `document.querySelector('#hr-notes-pending [data-hr-annotation]') !== null`,
    );
    assert(card === true, "no card in the pending list after the annotation was submitted");
    const annotation = pending[0] as JsonObject;
    assertIncludes(String(annotation["comment"]), "MCP 闭环批注", "annotation content");
    const targetId = annotation["targetId"];
    const anId = annotation["id"];
    assert(
      typeof targetId === "string" && typeof anId === "string",
      "annotation is missing targetId/id",
    );

    const fixed = await mcp.call("hr_patch_node", {
      filePath: DOC,
      nodeId: targetId,
      action: "replace",
      htmlContent: `<p data-hr-id="${targetId}">已按批注修订。</p>`,
    });
    assert(!fixed.isError, `annotation-driven patch failed: ${fixed.text}`);
    const resolved = await mcp.call("hr_resolve_annotation", {
      filePath: DOC,
      annotationId: anId,
      resolutionNote: "已修订该段",
    });
    assert(!resolved.isError, `hr_resolve_annotation errored: ${resolved.text}`);
    const after = toolJson(
      await mcp.call("hr_outline", { filePath: DOC }),
      "hr_outline (after resolve)",
    );
    assertEq(
      JSON.stringify(after["pendingAnnotations"]),
      "[]",
      "pending annotations remain after resolve",
    );
    const archived = await page.wait(
      `document.querySelector('#hr-notes-resolved [data-hr-annotation]') !== null`,
    );
    assert(archived === true, "no archived card appeared in the right rail after resolve");
  });

  test("should reject out-of-order calls: undo before any write, patch on a deleted node, resolve on a nonexistent annotation", async () => {
    const ws2 = sandbox("managed-oos");
    try {
      await newDoc(ws2.ws, "fresh.hr.html");
      const undo = await hr(["undo", "fresh.hr.html", "--workspace", ws2.ws, "--json"], {
        cwd: ws2.ws,
      });
      assertEq(undo.code, 1, "empty-history undo exit code");
      assertEq(
        errorOf(undo, "empty-history undo").code,
        "nothing_to_undo",
        "empty-history undo error code",
      );

      await newDoc(ws2.ws, "victim.hr.html");
      const victimHtml = await readFile(docPath(ws2.ws, "victim.hr.html"), "utf8");
      // The file's first data-hr-id is the container (article/root, must not be
      // deleted); take the last leaf block.
      const allIds = [...victimHtml.matchAll(/data-hr-id="([^"]+)"/gu)].map((m) => m[1]);
      const target = allIds.at(-1);
      assert(target !== undefined, "no data-hr-id in the hr new skeleton");
      const removed = await hr(
        ["patch", "victim.hr.html", target, "--action", "delete", "--workspace", ws2.ws, "--json"],
        { cwd: ws2.ws },
      );
      assertEq(removed.code, 0, "delete-block exit code");
      const again = await hr(
        ["patch", "victim.hr.html", target, "--action", "delete", "--workspace", ws2.ws, "--json"],
        { cwd: ws2.ws },
      );
      assertEq(
        errorOf(again, "patch deleted node").code,
        "node_not_found",
        "patch-deleted-node error code",
      );

      const bogus = await mcp.call("hr_resolve_annotation", {
        filePath: DOC,
        annotationId: "an_deadbeef",
      });
      assert(bogus.isError, "resolving a nonexistent annotation unexpectedly succeeded");
    } finally {
      ws2.cleanup();
    }
  });

  test("should refresh via watcher/SSE for both direct external writes and tmp+rename edits", async () => {
    const path = docPath(home.ws, DOC);
    const before = await readFile(path, "utf8");
    // Inject text into the first <p data-hr-id> block: a new node without an id
    // can't enter the block-level diff.
    const injected = before.replace(/(<p data-hr-id="[^"]+">)/u, "$1外部直写标记 EXT-DIRECT ");
    assert(injected !== before, "direct-write injection point not found");
    await writeFile(path, injected, "utf8");
    const direct = await page.wait(
      `document.querySelector('#hr-doc').textContent.includes('EXT-DIRECT')`,
    );
    assert(direct === true, "the direct external write did not reach the reader via watcher/SSE");

    const staged = injected.replace("EXT-DIRECT", "RENAME-替换标记");
    const tmp = join(home.ws, `.swap-${String(process.pid)}.tmp`);
    await writeFile(tmp, staged, "utf8");
    await rename(tmp, path);
    const swapped = await page.wait(
      `document.querySelector('#hr-doc').textContent.includes('RENAME-替换标记')`,
    );
    assert(swapped === true, "the tmp+rename rewrite did not reach the reader via watcher/SSE");
  });

  test("should return to hr new's initial bytes after repeated undos", async () => {
    for (let i = 0; i < 15; i += 1) {
      const undo = await hr(["undo", DOC, "--workspace", home.ws, "--json"], { cwd: home.ws });
      if (undo.code !== 0) {
        assertEq(
          errorOf(undo, "undo exhausted").code,
          "nothing_to_undo",
          "error code when undo is exhausted",
        );
        break;
      }
      assert(
        i < 14,
        "15 undos still have not exhausted the snapshot chain (history pruning should be ≤10)",
      );
    }
    const finalSha = sha256File(await readFile(docPath(home.ws, DOC)));
    assertEq(
      finalSha,
      initialSha,
      "document sha after undo bottoms out (should equal hr new's initial bytes)",
    );
    const seen = await page.wait(`document.querySelector('#hr-doc').textContent.includes('要点')`);
    assert(seen === true, "the reader did not sync back after undo returned to the initial state");
  });

  test("should switch the reader to reconnecting after SIGTERM and recover on a daemon restart", async () => {
    const code = await daemon.stop();
    assert(code === 0 || code === null, `abnormal exit code after SIGTERM: ${String(code)}`);
    assert(!daemonFileExists(daemon.home), "daemon.json not cleaned up after SIGTERM");
    const conn = await page.wait(
      `(() => { const el = document.querySelector('#hr-conn'); return el && /重连|离线/.test(el.textContent) ? el.textContent : false; })()`,
      25_000,
    );
    assert(
      conn !== false,
      `the status bar did not switch to reconnecting/offline after the disconnect (current: ${String(await textOf("#hr-conn"))})`,
    );

    // A new daemon means a new port + new token: the old page's SSE can never
    // come back — the degraded state is terminal.
    // Recovery path = reopen with the new daemon's url (equivalent to the user
    // reopening the link).
    daemon = await startServe({ file: DOC, workspace: home.ws, home: home.home });
    api = await connect(daemon.port, daemon.token);
    await page.navigate(daemon.url);
    const again = await page.wait(`document.querySelector('#hr-doc [data-hr-id]') !== null`);
    assert(again === true, "the reader did not recover after the daemon restart + reopen");
    const conn2 = await page.wait(
      `(() => { const el = document.querySelector('#hr-conn'); return el && el.textContent.includes('已同步') ? el.textContent : false; })()`,
      20_000,
    );
    assert(conn2 !== false, "the status bar did not return to synced after the daemon restart");
  });

  test("should handle SIGINT as gracefully as SIGTERM (daemon.json removed, port released)", async () => {
    daemon.proc.kill("SIGINT");
    const code = await daemon.proc.exited;
    assert(code === 0 || code === null, `abnormal exit code after SIGINT: ${String(code)}`);
    assert(!daemonFileExists(daemon.home), "daemon.json not cleaned up after SIGINT");
    const closed = await until(
      () => portClosed(daemon.port),
      (v) => v,
    );
    assert(closed, `port ${String(daemon.port)} still listening after SIGINT`);
    const dead = await fetch(`http://127.0.0.1:${String(daemon.port)}/healthz`).then(
      () => false,
      () => true,
    );
    assert(dead, "healthz still reachable after SIGINT");
  });
});
