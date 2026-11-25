// state.js：apiPost 的响应契约、偏好读写与迁移、桥导航令牌、转义与 docId 解析。
import { describe, expect, it, vi } from "vitest";

import { createSandbox } from "./harness.ts";
import type { Sandbox } from "./harness.ts";

function fetchMock(s: Sandbox, init: { ok: boolean; status: number; text: string }) {
  const mock = vi.fn(() =>
    Promise.resolve(
      new s.window.Response(init.text, {
        status: init.status,
        statusText: init.ok ? "OK" : "ERR",
      }),
    ),
  );
  Object.assign(s.window, { fetch: mock });
  return mock;
}

describe("apiPost", () => {
  it("成功时回传 JSON body，且请求带 csrf 头与 same-origin 凭据", async () => {
    const s = createSandbox();
    const mock = fetchMock(s, { ok: true, status: 200, text: '{"done":true,"n":3}' });
    const out = (await s.hrd.apiPost("/api/patch", { docId: "a.html" })) as Record<string, unknown>;
    expect(out).toEqual({ done: true, n: 3 });
    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/patch");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    const headers = new Headers(init.headers);
    expect(headers.get("x-hr-csrf")).toBe("1");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ docId: "a.html" });
    s.dispose();
  });

  it("HTTP 失败优先用 JSON 的 message，其次 code，兜底状态码", async () => {
    const s = createSandbox();
    fetchMock(s, { ok: false, status: 500, text: '{"message":"磁盘只读","code":"io"}' });
    await expect(s.hrd.apiPost("/api/patch", {})).rejects.toThrow("磁盘只读");

    fetchMock(s, { ok: false, status: 403, text: '{"code":"forbidden"}' });
    await expect(s.hrd.apiPost("/api/patch", {})).rejects.toThrow("forbidden");

    fetchMock(s, { ok: false, status: 502, text: "not json at all" });
    await expect(s.hrd.apiPost("/api/patch", {})).rejects.toThrow("HTTP 502");
    s.dispose();
  });

  it("响应体非 JSON 但 200：parseJsonSafe 回退成空对象", async () => {
    const s = createSandbox();
    fetchMock(s, { ok: true, status: 200, text: "<html>oops</html>" });
    const out = await s.hrd.apiPost("/api/x", {});
    expect(out).toEqual({});
    s.dispose();
  });

  it("fetch 自身 reject（断网）：错误原样冒泡", async () => {
    const s = createSandbox();
    Object.assign(s.window, {
      fetch: vi.fn(() => Promise.reject(new Error("connection refused"))),
    });
    await expect(s.hrd.apiPost("/api/patch", {})).rejects.toThrow("connection refused");
    s.dispose();
  });
});

describe("bridgeNavigate", () => {
  it("带会话令牌发起 hr-desktop.local 桥导航", () => {
    const s = createSandbox({ ctx: { bridgeToken: "tok-9" } });
    s.hrd.bridgeNavigate("/drag");
    expect(s.window.location.href).toBe("http://hr-desktop.local/drag?t=tok-9");
    s.dispose();
  });

  it("路径已带 query 时用 & 追加令牌", () => {
    const s = createSandbox({ ctx: { bridgeToken: "t" } });
    s.hrd.bridgeNavigate("/open?doc=a%20b.html");
    expect(s.window.location.href).toBe("http://hr-desktop.local/open?doc=a%20b.html&t=t");
    s.dispose();
  });

  it("/pick-folder 额外清掉侧边栏的 sessionStorage 记忆", () => {
    const s = createSandbox();
    s.window.sessionStorage.setItem("hrd_sidebar_tab", "toc");
    s.window.sessionStorage.setItem("hrd_auto_outline", "1");
    s.hrd.bridgeNavigate("/pick-folder");
    expect(s.window.sessionStorage.getItem("hrd_sidebar_tab")).toBeNull();
    expect(s.window.sessionStorage.getItem("hrd_auto_outline")).toBeNull();
    s.dispose();
  });
});

describe("偏好读写", () => {
  it("无存储时给默认值；存的字段会合并进默认集", () => {
    const s = createSandbox();
    expect(s.hrd.state.prefs.uiTheme).toBe("light");
    s.dispose();

    const s2 = createSandbox({
      beforeLoad: (win) => {
        win.localStorage.setItem(
          "hr_desktop_prefs_v3",
          JSON.stringify({ uiTheme: "dark", fontSize: 21 }),
        );
      },
    });
    expect(s2.hrd.state.prefs.uiTheme).toBe("dark");
    expect(s2.hrd.state.prefs.fontSize).toBe(21);
    // 未存的键回落默认值。
    expect(s2.hrd.state.prefs.maxWidth).toBe("740px");
    s2.dispose();
  });

  it("v3 缺失时迁移 v2 偏好；坏 JSON 回退默认", () => {
    const s = createSandbox({
      beforeLoad: (win) => {
        win.localStorage.setItem(
          "hr_desktop_prefs_v2",
          JSON.stringify({ fontSize: 19, focusMode: true }),
        );
      },
    });
    expect(s.hrd.state.prefs.fontSize).toBe(19);
    expect(s.hrd.state.prefs.focusMode).toBe(true);
    s.dispose();

    const s2 = createSandbox({
      beforeLoad: (win) => {
        win.localStorage.setItem("hr_desktop_prefs_v3", "{broken json");
      },
    });
    expect(s2.hrd.state.prefs.uiTheme).toBe("light");
    s2.dispose();
  });

  it("savePrefs 写回 localStorage 并同步 state", () => {
    const s = createSandbox();
    s.hrd.savePrefs({ ...s.hrd.state.prefs, uiTheme: "paper" });
    const raw = s.window.localStorage.getItem("hr_desktop_prefs_v3");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(String(raw)) as Record<string, unknown>;
    expect(parsed["uiTheme"]).toBe("paper");
    expect(s.hrd.state.prefs.uiTheme).toBe("paper");
    s.dispose();
  });
});

describe("文档上下文解析", () => {
  it('escapeHtmlText 转义 &<>"', () => {
    const s = createSandbox();
    expect(s.hrd.escapeHtmlText('<a href="x">&"y"</a>')).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&quot;y&quot;&lt;/a&gt;",
    );
    s.dispose();
  });

  it("currentDocId：?doc > /s/<id> > ctx.docId", () => {
    const byQuery = createSandbox({ url: "http://127.0.0.1:8123/?doc=q%20doc.html" });
    expect(byQuery.hrd.currentDocId()).toBe("q doc.html");
    byQuery.dispose();

    const byPath = createSandbox({ url: "http://127.0.0.1:8123/s/sub%20dir/d.html" });
    expect(byPath.hrd.currentDocId()).toBe("sub dir/d.html");
    byPath.dispose();

    const byCtx = createSandbox({ ctx: { docId: "ctx.html" } });
    expect(byCtx.hrd.currentDocId()).toBe("ctx.html");
    byCtx.dispose();
  });

  it("isEmptyMode 在没有 docId 时为真", () => {
    const s = createSandbox({ ctx: { docId: "" } });
    expect(s.hrd.isEmptyMode()).toBe(true);
    s.dispose();
  });
});
