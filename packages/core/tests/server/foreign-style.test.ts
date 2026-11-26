// 这层管：外来文档的换主题口径——`/api/style` 放行（只写 `<style id="hr-theme">` 区间），
// patch/批注对外来文档继续 422 且零写盘；undo 不加闸，样式快照照样能退回原字节。

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { httpCall, jsonBodyOf, type TestServer, withServer } from "./harness";
import { withPost } from "./wire";

const FOREIGN = [
  "<!doctype html>",
  "<html><head><title>anim</title><script>const go=()=>requestAnimationFrame(go)</script></head>",
  '<body><div class="app">外来内容<script>go()</script></div></body></html>',
].join("\r\n");

const foreignSeed = (workspace: string): void => {
  writeFileSync(join(workspace, "doc.html"), FOREIGN, "utf8");
};

const post = (ctx: TestServer, path: string, body: Readonly<Record<string, unknown>>) =>
  httpCall(ctx.port, {
    method: "POST",
    path,
    headers: withPost(ctx.token),
    body: JSON.stringify(body),
  });

const applyTheme = (ctx: TestServer, visualId: string, docId = "doc.html") =>
  post(ctx, "/api/style", { docId, visualId });

const undo = (ctx: TestServer, docId = "doc.html") =>
  post(ctx, `/api/doc/${encodeURIComponent(docId)}/undo`, {});

const countThemeAnchors = (html: string): number =>
  html.match(/<style\b[^>]*\bid=["']hr-theme["'][^>]*>/giu)?.length ?? 0;

describe("foreign doc · /api/style", () => {
  it("should apply a theme to a foreign doc: 200 with changed/revision and empty changedNodes", async () => {
    await withServer(async (ctx) => {
      const response = await applyTheme(ctx, "atelier-editorial");

      expect(response.status).toBe(200);
      expect(jsonBodyOf(response)).toMatchObject({ changed: true, changedNodes: [] });
      expect(jsonBodyOf(response)).toHaveProperty("revision");
      const html = readFileSync(ctx.file, "utf8");
      expect(html).toContain('<style id="hr-theme">');
      expect(html).toContain("--hr-bg: #faf8f5");
      // 主题块之外的字节原样：正文与脚本一个字都没动。
      expect(html).toContain('<div class="app">外来内容<script>go()</script></div>');
    }, foreignSeed);
  });

  it("should switch themes on a foreign doc, then undo back to the original bytes", async () => {
    await withServer(async (ctx) => {
      const original = readFileSync(ctx.file);
      expect((await applyTheme(ctx, "atelier-editorial")).status).toBe(200);
      expect((await applyTheme(ctx, "deck-noir")).status).toBe(200);
      expect(readFileSync(ctx.file, "utf8")).toContain("--hr-bg: #0a0d14");

      expect((await undo(ctx)).status).toBe(200);
      // 第一次 undo 退回上一套主题的字节，第二次才回到原文。
      expect(readFileSync(ctx.file, "utf8")).toContain("--hr-bg: #faf8f5");
      expect(readFileSync(ctx.file)).not.toEqual(original);
      expect((await undo(ctx)).status).toBe(200);
      expect(readFileSync(ctx.file)).toEqual(original);
    }, foreignSeed);
  });

  it("should report changed:false when the same theme is re-applied to a foreign doc", async () => {
    await withServer(async (ctx) => {
      expect((await applyTheme(ctx, "atelier-editorial")).status).toBe(200);
      const second = await applyTheme(ctx, "atelier-editorial");

      expect(second.status).toBe(200);
      expect(jsonBodyOf(second)).toMatchObject({ changed: false, changedNodes: [] });
    }, foreignSeed);
  });

  it("should inject a head-mounted theme block when the foreign doc has no <head>", async () => {
    await withServer(
      async (ctx) => {
        const response = await applyTheme(ctx, "atelier-editorial");

        expect(response.status).toBe(200);
        expect(jsonBodyOf(response)).toMatchObject({ changed: true, changedNodes: [] });
        const html = readFileSync(ctx.file, "utf8");
        expect(html).toContain('<head><style id="hr-theme">');
        expect(html).toContain("<p>没有 head 的外来页</p>");
      },
      (workspace) => {
        writeFileSync(
          join(workspace, "doc.html"),
          "<!doctype html><html><body><p>没有 head 的外来页</p></body></html>",
          "utf8",
        );
      },
    );
  });

  it("should converge multiple existing hr-theme blocks into a single anchor", async () => {
    await withServer(
      async (ctx) => {
        const response = await applyTheme(ctx, "deck-noir");

        expect(response.status).toBe(200);
        const html = readFileSync(ctx.file, "utf8");
        expect(countThemeAnchors(html)).toBe(1);
        expect(html).toContain("--hr-bg: #0a0d14");
        expect(html).not.toContain("旧主题一");
        expect(html).not.toContain("旧主题二");
      },
      (workspace) => {
        writeFileSync(
          join(workspace, "doc.html"),
          [
            "<!doctype html><html><head><style id='hr-theme'>/* 旧主题一 */</style></head>",
            '<body><div>x</div><style id="hr-theme">/* 旧主题二 */</style></body></html>',
          ].join(""),
          "utf8",
        );
      },
    );
  });

  it("should keep BOM and CRLF outside the theme block byte-identical", async () => {
    const seeded =
      "\ufeff<!doctype html>\r\n<html><head><title>b</title></head>\r\n<body><p>带 BOM 的外来页</p></body></html>\r\n";
    await withServer(
      async (ctx) => {
        const response = await applyTheme(ctx, "atelier-editorial");

        expect(response.status).toBe(200);
        const html = readFileSync(ctx.file, "utf8");
        // BOM 先于 doctype 时 `replaceTheme` 按既有口径在 prologue 后补一个合成 head；
        // 原文件的 BOM、doctype 与块外 CRLF 仍逐字节保留（块内换行来自主题 CSS 本身）。
        expect(html.startsWith("\ufeff<!doctype html>")).toBe(true);
        expect(html).toContain(
          "</style></head>\r\n<html><head><title>b</title></head>\r\n<body><p>带 BOM 的外来页</p></body></html>\r\n",
        );
        expect(countThemeAnchors(html)).toBe(1);
      },
      (workspace) => {
        writeFileSync(join(workspace, "doc.html"), seeded, "utf8");
      },
    );
  });

  it("should not write the file when the requested theme is unknown", async () => {
    await withServer(async (ctx) => {
      const before = readFileSync(ctx.file);
      const response = await applyTheme(ctx, "no-such-theme");

      expect(response.status).toBe(404);
      expect(jsonBodyOf(response)).toMatchObject({ code: "unknown_style" });
      expect(readFileSync(ctx.file)).toEqual(before);
    }, foreignSeed);
  });
});

describe("foreign doc · 内容写依旧全拒", () => {
  it("should reject patch, fragment annotation and annotation-add with 422 and zero writes", async () => {
    await withServer(async (ctx) => {
      const before = readFileSync(ctx.file);
      const patch = await post(ctx, "/api/patch", {
        docId: "doc.html",
        action: "append",
        targetId: "hr-x",
        fragment: "<b>x</b>",
      });
      const annotation = await post(ctx, "/api/annotation", {
        docId: "doc.html",
        start: 0,
        end: 4,
        text: "外来",
      });
      const annotationAdd = await post(ctx, "/api/doc/doc.html/annotations", {
        nodeId: "hr-x",
        note: "n",
        anchor: { exact: "外来", start: 0 },
      });

      for (const response of [patch, annotation, annotationAdd]) {
        expect(response.status).toBe(422);
        expect(jsonBodyOf(response)).toMatchObject({ code: "invalid_document" });
      }
      expect(readFileSync(ctx.file)).toEqual(before);
    }, foreignSeed);
  });
});
