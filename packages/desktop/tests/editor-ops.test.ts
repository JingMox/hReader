// editor-ops.js：块补丁队列、保存状态机、Markdown 前缀、插入/删除/撤销——全部走 apiPost 契约。
import { describe, expect, it, vi } from "vitest";
import type { Element, HTMLElement } from "happy-dom";

import { createSandbox, mustGet } from "./harness.ts";
import type { Sandbox } from "./harness.ts";

const DOC_HTML = `
  <div id="hr-root">
    <div id="hr-doc">
      <article data-hr-id="doc">
        <p data-hr-id="b1">第一段</p>
        <h2 data-hr-id="b2">小节</h2>
      </article>
    </div>
    <span id="hrd-save-state"></span>
  </div>
`;

function docSandbox(): Sandbox {
  return createSandbox({
    html: DOC_HTML,
    modules: ["state.js", "editor-dom.js", "editor-ops.js"],
    bootstrap: false,
  });
}

function postSpy(s: Sandbox) {
  const spy = vi.fn(() => Promise.resolve({ ok: true }));
  s.hrd.apiPost = spy;
  return spy;
}

function block(s: Sandbox, id: string): Element {
  return mustGet(s.document, `#hr-doc [data-hr-id="${id}"]`);
}

describe("flushBlockSave", () => {
  it("脏块被保存：patch 请求 replace + 序列化片段，保存状态机走完", async () => {
    const s = docSandbox();
    const post = postSpy(s);
    const el = block(s, "b1");
    el.textContent = "改写后的<内容>";
    s.hrd.state.editDirty = true;
    const res = await s.hrd.flushBlockSave(el);
    expect(res).toEqual({ ok: true });
    expect(post).toHaveBeenCalledWith("/api/patch", {
      docId: "doc.html",
      targetId: "b1",
      action: "replace",
      fragment: "<p>改写后的&lt;内容&gt;</p>",
    });
    expect(s.hrd.state.editDirty).toBe(false);
    s.dispose();
  });

  it("未脏不发文；空文档模式下直接短路", async () => {
    const s = docSandbox();
    const post = postSpy(s);
    await s.hrd.flushBlockSave(block(s, "b1"));
    expect(post).not.toHaveBeenCalled();

    const empty = createSandbox({ ctx: { docId: "" } });
    const post2 = postSpy(empty);
    empty.hrd.state.editDirty = true;
    await empty.hrd.flushBlockSave(empty.document.createElement("p"));
    expect(post2).not.toHaveBeenCalled();
    s.dispose();
    empty.dispose();
  });

  it("apiPost 失败：toast 报错且 saveInFlight 链不挂死（下一次保存仍能跑）", async () => {
    const s = docSandbox();
    let calls = 0;
    s.hrd.apiPost = vi.fn(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("写入被拒")) : Promise.resolve({ ok: true });
    });
    s.hrd.showToast = vi.fn();
    const el = block(s, "b1");
    s.hrd.state.editDirty = true;
    await s.hrd.flushBlockSave(el);
    expect(s.hrd.showToast).toHaveBeenCalledWith("保存失败：写入被拒", true);
    // saveInFlight 以 .then(fn, fn) 续链：上一次失败不得卡死下一次保存。
    s.hrd.state.editDirty = true;
    const second = await s.hrd.flushBlockSave(el);
    expect(second).toEqual({ ok: true });
    expect(s.hrd.apiPost).toHaveBeenCalledTimes(2);
    s.dispose();
  });
});

describe("tryMarkdownPrefix / convertBlockTag", () => {
  it("p 标签里 '# ' 前缀转 h1 并落 patch；非 p 标签不转", async () => {
    const s = docSandbox();
    const post = postSpy(s);
    const el = block(s, "b1") as HTMLElement;
    el.textContent = "# 新标题";
    expect(s.hrd.tryMarkdownPrefix(el)).toBe(true);
    await s.hrd.state.saveInFlight;
    expect(post).toHaveBeenCalledWith("/api/patch", {
      docId: "doc.html",
      targetId: "b1",
      action: "replace",
      fragment: "<h1>新标题</h1>",
    });
    expect(el.textContent).toBe("新标题");

    const h2 = block(s, "b2") as HTMLElement;
    h2.textContent = "# 不该转";
    expect(s.hrd.tryMarkdownPrefix(h2)).toBe(false);
    s.dispose();
  });

  it("convertBlockTag 用 escape 后的文本重包裹", async () => {
    const s = docSandbox();
    const post = postSpy(s);
    const el = block(s, "b1") as HTMLElement;
    el.textContent = 'a <b> & "c"';
    await s.hrd.convertBlockTag(el, "blockquote");
    expect(post).toHaveBeenCalledWith("/api/patch", {
      docId: "doc.html",
      targetId: "b1",
      action: "replace",
      fragment: "<blockquote>a &lt;b&gt; &amp; &quot;c&quot;</blockquote>",
    });
    s.dispose();
  });
});

describe("insertAfterBlock / deleteBlock / undoDocument", () => {
  it("insert_after 带片段；组件 toast 提示 label", async () => {
    const s = docSandbox();
    const post = postSpy(s);
    s.hrd.showToast = vi.fn();
    (s.hrd.apiPost as ReturnType<typeof vi.fn>).mockResolvedValue({
      newIds: ["b3"],
    });
    const res = await s.hrd.insertAfterBlock(block(s, "b1"), "<p>新段</p>", "段落", false);
    expect(res).toEqual({ newIds: ["b3"] });
    expect(post).toHaveBeenCalledWith("/api/patch", {
      docId: "doc.html",
      targetId: "b1",
      action: "insert_after",
      fragment: "<p>新段</p>",
    });
    expect(s.hrd.showToast).toHaveBeenCalledWith("已插入：段落");
    s.dispose();
  });

  it("最后一块不许删；多块时发 delete 且聚焦邻块", async () => {
    const s = docSandbox();
    s.hrd.showToast = vi.fn();
    const post = postSpy(s);
    // contentBlocks() 有两块：删 b1 应成功。
    await s.hrd.deleteBlock(block(s, "b1"));
    expect(post).toHaveBeenCalledWith("/api/patch", {
      docId: "doc.html",
      targetId: "b1",
      action: "delete",
    });

    const lone = createSandbox({
      html: `<div id="hr-doc"><article data-hr-id="d"><p data-hr-id="only">独苗</p></article></div>`,
      modules: ["state.js", "editor-dom.js", "editor-ops.js"],
      bootstrap: false,
    });
    lone.hrd.showToast = vi.fn();
    const post2 = postSpy(lone);
    await lone.hrd.deleteBlock(mustGet(lone.document, "[data-hr-id=only]"));
    expect(post2).not.toHaveBeenCalled();
    expect(lone.hrd.showToast).toHaveBeenCalledWith("至少保留一个正文节点", true);
    s.dispose();
    lone.dispose();
  });

  it("undoDocument 走 /api/doc/<id>/undo；失败给 toast 不抛", async () => {
    const s = docSandbox();
    const post = postSpy(s);
    s.hrd.showToast = vi.fn();
    await s.hrd.undoDocument();
    expect(post).toHaveBeenCalledWith("/api/doc/doc.html/undo", {});
    expect(s.hrd.showToast).toHaveBeenCalledWith("已撤销上次文档快照");

    s.hrd.apiPost = vi.fn(() => Promise.reject(new Error("无快照")));
    await s.hrd.undoDocument();
    expect(s.hrd.showToast).toHaveBeenCalledWith("无法撤销：无快照", true);
    s.dispose();
  });

  it("persistStyle 发 /api/style", async () => {
    const s = docSandbox();
    const post = postSpy(s);
    s.hrd.showToast = vi.fn();
    await s.hrd.persistStyle("atelier-editorial");
    expect(post).toHaveBeenCalledWith("/api/style", {
      docId: "doc.html",
      visualId: "atelier-editorial",
    });
    s.dispose();
  });
});
