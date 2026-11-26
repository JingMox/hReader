// 偏好设置里的"外来 HTML 权限"一节：读写只走 core 的 /api/permissions，
// 不落 webview prefs（服务端拿不到本地存储）。GET 失败时两框保持禁用，
// 不把占位的"逐个文档"当真理写回去。
import { describe, expect, it, vi, type Mock } from "vitest";
import type { HTMLSelectElement } from "happy-dom";

import { createSandbox, mustGet } from "./harness.ts";
import type { Sandbox } from "./harness.ts";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** happy-dom 的 fetch 自带真实网络：按 harness 的 Object.assign 惯例换成可控 stub。 */
function stubModesFetch(s: Sandbox, modes: unknown, status = 200): Mock {
  const fetchMock = vi.fn((input: unknown) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : String((input as { url?: unknown }).url);
    const body = url === "/api/permissions" ? JSON.stringify({ modes }) : "{}";
    return Promise.resolve(new s.window.Response(body, { status }));
  });
  Object.assign(s.window, { fetch: fetchMock });
  return fetchMock;
}

function permSelects(s: Sandbox): { scripts: HTMLSelectElement; network: HTMLSelectElement } {
  return {
    scripts: mustGet(s.document, "#hrd-set-perm-scripts") as HTMLSelectElement,
    network: mustGet(s.document, "#hrd-set-perm-network") as HTMLSelectElement,
  };
}

/** 打开设置弹窗并等回填 Promise 落地；返回 fetch 间谍供断言。 */
async function openSettings(s: Sandbox, modes: unknown): Promise<Mock> {
  const fetchMock = stubModesFetch(s, modes);
  s.hrd.openSettingsModal();
  await flush();
  return fetchMock;
}

describe("设置弹窗 · 外来 HTML 权限", () => {
  it("打开时 GET /api/permissions 并回填两个三选一", async () => {
    const s = createSandbox();
    const fetchMock = await openSettings(s, { scripts: "allow", network: "deny" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/permissions",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    const { scripts, network } = permSelects(s);
    expect(scripts.value).toBe("allow");
    expect(network.value).toBe("deny");
    expect(scripts.disabled).toBe(false);
    expect(network.disabled).toBe(false);
    s.dispose();
  });

  it("完成时把两个模式 POST 到 /api/permissions（不落 prefs）", async () => {
    const s = createSandbox();
    await openSettings(s, { scripts: "per-doc", network: "per-doc" });
    const post = vi.fn().mockResolvedValue({ modes: { scripts: "deny", network: "allow" } });
    s.hrd.apiPost = post;

    const { scripts, network } = permSelects(s);
    scripts.value = "deny";
    network.value = "allow";
    (mustGet(s.document, "#hrd-set-done") as HTMLSelectElement).click();
    await flush();

    expect(post).toHaveBeenCalledWith("/api/permissions", {
      scripts: "deny",
      network: "allow",
    });
    expect(s.hrd.state.prefs).not.toHaveProperty("scripts");
    s.dispose();
  });

  it("GET 失败：两框保持禁用且完成按钮不再写权限", async () => {
    const s = createSandbox();
    Object.assign(s.window, {
      fetch: vi.fn(() => Promise.resolve(new s.window.Response("{}", { status: 500 }))),
    });
    s.hrd.openSettingsModal();
    await flush();

    const { scripts, network } = permSelects(s);
    expect(scripts.disabled).toBe(true);
    expect(network.disabled).toBe(true);

    const post = vi.fn().mockResolvedValue({});
    s.hrd.apiPost = post;
    (mustGet(s.document, "#hrd-set-done") as HTMLSelectElement).click();
    await flush();
    expect(
      post.mock.calls.filter((call) => call[0] === "/api/permissions"),
      "占位值不许写回服务端",
    ).toHaveLength(0);
    s.dispose();
  });

  it("恢复默认把两个全局档复位为逐个文档", async () => {
    const s = createSandbox();
    await openSettings(s, { scripts: "allow", network: "allow" });
    const post = vi.fn().mockResolvedValue({ modes: { scripts: "per-doc", network: "per-doc" } });
    s.hrd.apiPost = post;

    (mustGet(s.document, "#hrd-set-reset") as HTMLSelectElement).click();
    await flush();

    expect(post).toHaveBeenCalledWith("/api/permissions", {
      scripts: "per-doc",
      network: "per-doc",
    });
    s.dispose();
  });

  it("畸形 modes 不炸、不解禁", async () => {
    const s = createSandbox();
    await openSettings(s, "garbage");
    const { scripts, network } = permSelects(s);
    expect(scripts.disabled).toBe(true);
    expect(network.disabled).toBe(true);
    s.dispose();
  });

  it("should keep both selects disabled and write nothing when modes carry out-of-range values", async () => {
    // `modes` shaped like an object but with values outside the enum is just as
    // malformed as "garbage": enabling the selects would put "" in the field and
    // Done would POST a body the server must reject — the same lock-up applies.
    const s = createSandbox();
    await openSettings(s, { scripts: "bogus", network: "deny" });
    const { scripts, network } = permSelects(s);
    expect(scripts.disabled).toBe(true);
    expect(network.disabled).toBe(true);

    const post = vi.fn().mockResolvedValue({});
    s.hrd.apiPost = post;
    (mustGet(s.document, "#hrd-set-done") as HTMLSelectElement).click();
    await flush();
    expect(
      post.mock.calls.filter((call) => call[0] === "/api/permissions"),
      "越界模式值不许写回服务端",
    ).toHaveLength(0);
    s.dispose();
  });
});
