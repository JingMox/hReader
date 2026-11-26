// 这层管：trust 的对抗面——并发 grant 不互相丢、只读 trust.json 报 500 且不丢旧授权、
// API 写改动字节即失效、子目录外来文档也能授权。

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { cookieOf, defaultSeed, httpCall, jsonBodyOf, withServer } from "./harness";
import { withPost } from "./wire";

const FOREIGN =
  '<!doctype html><html><body><div class="app"><script>1</script>外来</div></body></html>';

const twoForeignSeed = (workspace: string): void => {
  defaultSeed(workspace);
  writeFileSync(join(workspace, "a.html"), FOREIGN, "utf8");
  writeFileSync(join(workspace, "b.html"), `${FOREIGN}<!-- b -->`, "utf8");
};

const subForeignSeed = (workspace: string): void => {
  defaultSeed(workspace);
  mkdirSync(join(workspace, "sub"));
  writeFileSync(join(workspace, "sub", "deep.html"), FOREIGN, "utf8");
};

const grant = (port: number, token: string, docId: string): Promise<number> =>
  httpCall(port, {
    method: "POST",
    path: `/api/doc/${encodeURIComponent(docId)}/trust`,
    headers: withPost(token),
    body: JSON.stringify({ level: "local" }),
  }).then((response) => response.status);

const cspOf = async (port: number, token: string, docId: string): Promise<string> => {
  const response = await httpCall(port, {
    path: `/s/${encodeURIComponent(docId)}`,
    headers: { cookie: cookieOf(token) },
  });
  return String(response.headers["content-security-policy"] ?? "");
};

const trustFileOf = (workspace: string): string => join(workspace, ".hreader", "trust.json");

describe("trust · 并发 grant", () => {
  it("should keep both grants when two docs are granted in parallel", async () => {
    await withServer(async (ctx) => {
      const [first, second] = await Promise.all([
        grant(ctx.port, ctx.token, "a.html"),
        grant(ctx.port, ctx.token, "b.html"),
      ]);

      expect([first, second]).toEqual([200, 200]);
      // 共享表由 trust.lock 串行化：两个写都落盘，trust.json 仍是合法 JSON。
      const table: unknown = JSON.parse(readFileSync(trustFileOf(ctx.workspace), "utf8"));
      expect(Object.keys(table as Record<string, unknown>)).toHaveLength(2);
      expect(await cspOf(ctx.port, ctx.token, "a.html")).toContain("sandbox allow-scripts");
      expect(await cspOf(ctx.port, ctx.token, "b.html")).toContain("sandbox allow-scripts");
    }, twoForeignSeed);
  });
});

describe("trust · 存储不可写", () => {
  it("should answer 500 and keep old grants when trust.json is read-only", async () => {
    await withServer(async (ctx) => {
      // 先给 a.html 授权落一份合法 trust.json，再把文件本身锁成只读。
      expect(await grant(ctx.port, ctx.token, "a.html")).toBe(200);
      const before = readFileSync(trustFileOf(ctx.workspace), "utf8");
      chmodSync(trustFileOf(ctx.workspace), 0o444);
      try {
        const denied = await httpCall(ctx.port, {
          method: "POST",
          path: "/api/doc/b.html/trust",
          headers: withPost(ctx.token),
          body: JSON.stringify({ level: "local" }),
        });

        expect(denied.status).toBe(500);
        // 只读位拦的是写入本身：旧授权一个字节都没动，b.html 也没被半写进表。
        expect(readFileSync(trustFileOf(ctx.workspace), "utf8")).toBe(before);
        expect(await cspOf(ctx.port, ctx.token, "a.html")).toContain("sandbox allow-scripts");
        expect(await cspOf(ctx.port, ctx.token, "b.html")).not.toContain("allow-scripts");
      } finally {
        chmodSync(trustFileOf(ctx.workspace), 0o644);
      }
    }, twoForeignSeed);
  });
});

describe("trust · 写入口", () => {
  const shaOf = (workspace: string, docId: string): string =>
    createHash("sha256")
      .update(readFileSync(join(workspace, docId)))
      .digest("hex");

  it("should refuse patch to foreign docs before touching the file, while style remains allowed", async () => {
    await withServer(async (ctx) => {
      expect(await grant(ctx.port, ctx.token, "a.html")).toBe(200);
      const shaBefore = shaOf(ctx.workspace, "a.html");
      const patch = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/patch",
        headers: withPost(ctx.token),
        body: JSON.stringify({
          docId: "a.html",
          action: "append",
          targetId: "hr-d",
          fragment: "<b>x</b>",
        }),
      });

      // 外来文档仍没有内容写入口：derive 缺 <article> → 422，拒绝发生在 writeAtomic 之前——
      // "报失败却已改盘"的半成品会当场废掉 sha 键信任档。
      expect(patch.status).toBe(422);
      expect(jsonBodyOf(patch)).toMatchObject({ code: "invalid_document" });
      expect(shaOf(ctx.workspace, "a.html")).toBe(shaBefore);
      expect(await cspOf(ctx.port, ctx.token, "a.html")).toContain("sandbox allow-scripts");

      // 换主题是确认的例外：只写 `<style id="hr-theme">` 区间并回 200。
      // 它确实改了字节，因此 sha 键授权同步失效，CSP 回落到不含 allow-scripts。
      const style = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/style",
        headers: withPost(ctx.token),
        body: JSON.stringify({ docId: "a.html", visualId: "atelier-editorial" }),
      });
      expect(style.status).toBe(200);
      expect(jsonBodyOf(style)).toMatchObject({ changed: true, changedNodes: [] });
      expect(shaOf(ctx.workspace, "a.html")).not.toBe(shaBefore);
      expect(await cspOf(ctx.port, ctx.token, "a.html")).not.toContain("allow-scripts");
    }, twoForeignSeed);
  });

  it("should still refuse patch and annotation-add when the foreign doc carries a stray data-hr-id", async () => {
    await withServer(async (ctx) => {
      writeFileSync(
        join(ctx.workspace, "c.html"),
        '<!doctype html><html><body><div data-hr-id="hr-d"><script>1</script>x</div></body></html>',
        "utf8",
      );
      expect(await grant(ctx.port, ctx.token, "c.html")).toBe(200);
      const shaBefore = shaOf(ctx.workspace, "c.html");
      const patch = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/patch",
        headers: withPost(ctx.token),
        body: JSON.stringify({
          docId: "c.html",
          action: "append",
          targetId: "hr-d",
          fragment: "<b>x</b>",
        }),
      });
      const add = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/doc/c.html/annotations",
        headers: withPost(ctx.token),
        body: JSON.stringify({ nodeId: "hr-d", anchor: { exact: "x", start: 0 }, note: "n" }),
      });

      // hr-id 骗得过定位，骗不过派生：缺 <article> → 422。连批注（hr-meta）也不许写进外来文档。
      expect(patch.status).toBe(422);
      expect(jsonBodyOf(patch)).toMatchObject({ code: "invalid_document" });
      expect(add.status).toBe(422);
      expect(jsonBodyOf(add)).toMatchObject({ code: "invalid_document" });
      expect(shaOf(ctx.workspace, "c.html")).toBe(shaBefore);
      expect(await cspOf(ctx.port, ctx.token, "c.html")).toContain("sandbox allow-scripts");
    }, twoForeignSeed);
  });

  it("should refuse the fragment-annotation entry on a foreign doc without writing", async () => {
    await withServer(async (ctx) => {
      expect(await grant(ctx.port, ctx.token, "a.html")).toBe(200);
      const shaBefore = shaOf(ctx.workspace, "a.html");
      const response = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/annotation",
        headers: withPost(ctx.token),
        body: JSON.stringify({ docId: "a.html", start: 0, end: 3, text: "外来" }),
      });

      // 片段批注会把 hr-meta 塞进外来文档再 422（写完才 derive）：gate 之后拒绝在前、字节不变。
      expect(response.status).toBe(422);
      expect(jsonBodyOf(response)).toMatchObject({ code: "invalid_document" });
      expect(shaOf(ctx.workspace, "a.html")).toBe(shaBefore);
      expect(await cspOf(ctx.port, ctx.token, "a.html")).toContain("sandbox allow-scripts");
    }, twoForeignSeed);
  });
});

describe("trust · 子目录", () => {
  it("should grant trust for a subdirectory foreign doc", async () => {
    await withServer(async (ctx) => {
      expect(await grant(ctx.port, ctx.token, "sub/deep.html")).toBe(200);
      expect(await cspOf(ctx.port, ctx.token, "sub/deep.html")).toContain("sandbox allow-scripts");
    }, subForeignSeed);
  });
});
