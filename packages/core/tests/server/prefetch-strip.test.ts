// 这层管：DNS 预取/预连接残余通道的服务层收口——
//   1. 所有 `/f/` 页面响应（`/s/` 302 的落点）都带 `X-DNS-Prefetch-Control: off`（托管与外来一视同仁）；
//   2. 联网关时下发的 HTML 摘掉 `<link rel=dns-prefetch|preconnect|prefetch|prerender|modulepreload>`；
//   3. 只改响应字节，磁盘上的文档原样；
//   4. 联网开时 `<link>` 原文下发（联网是全包开关）。

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { stripPrefetchLinks } from "../../src/html/prefetch";
import { defaultSeed, docPageOf, httpCall, jsonBodyOf, withServer } from "./harness";
import { withPost } from "./wire";

const PREFETCH_DOC = [
  "<!doctype html><html><head>",
  '<link rel="dns-prefetch" href="//tracker.example">',
  '<link rel="preconnect" href="https://cdn.example">',
  '<link rel="prefetch" href="https://evil.example/big.bin">',
  '<link rel="prerender" href="https://evil.example/next">',
  '<link rel="modulepreload" href="https://evil.example/mod.js">',
  '<link rel="canonical" href="https://author.example/original">',
  "</head><body><div>plain</div></body></html>",
].join("\n");

const foreignSeed =
  (html: string) =>
  (workspace: string): void => {
    defaultSeed(workspace);
    writeFileSync(join(workspace, "doc.html"), html, "utf8");
  };

// The page bytes now come from `/f/`: `/s/` 302s there and `docPageOf` follows.
const serveDoc = (
  port: number,
  token: string,
  docId = "doc.html",
): Promise<{
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}> =>
  docPageOf(port, token, docId).then((response) => ({
    status: response.status,
    headers: response.headers,
    body: response.body,
  }));

const postPermissions = (
  port: number,
  token: string,
  patch: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> =>
  httpCall(port, {
    method: "POST",
    path: "/api/doc/doc.html/permissions",
    headers: withPost(token),
    body: JSON.stringify(patch),
  }).then((response) => ({ status: response.status, body: jsonBodyOf(response) }));

describe("/f/ page responses · X-DNS-Prefetch-Control", () => {
  it("should send X-DNS-Prefetch-Control off for a managed doc", async () => {
    await withServer(async (ctx) => {
      const res = await serveDoc(ctx.port, ctx.token);

      expect(res.status).toBe(200);
      expect(res.headers["x-dns-prefetch-control"]).toBe("off");
    });
  });

  it("should send X-DNS-Prefetch-Control off for a foreign doc on every permission combo", async () => {
    await withServer(async (ctx) => {
      const before = await serveDoc(ctx.port, ctx.token);
      expect(before.headers["x-dns-prefetch-control"]).toBe("off");

      await postPermissions(ctx.port, ctx.token, { scripts: true, network: true });
      const after = await serveDoc(ctx.port, ctx.token);
      expect(after.headers["x-dns-prefetch-control"]).toBe("off");
    }, foreignSeed(PREFETCH_DOC));
  });
});

describe("/f/ page responses · prefetch link stripping", () => {
  it("should strip all prefetch-family links from a foreign doc when network is off", async () => {
    await withServer(async (ctx) => {
      const res = await serveDoc(ctx.port, ctx.token);

      for (const token_ of [
        "dns-prefetch",
        "preconnect",
        "prefetch",
        "prerender",
        "modulepreload",
      ]) {
        expect(res.body, `rel=${token_} must be stripped`).not.toContain(token_);
      }
      // 非预取类的 <link> 不属于残余通道：canonical 照常下发。
      expect(res.body).toContain('rel="canonical"');
    }, foreignSeed(PREFETCH_DOC));
  });

  it("should keep the document on disk byte-identical after a stripped serve", async () => {
    await withServer(async (ctx) => {
      const before = readFileSync(ctx.file, "utf8");
      await serveDoc(ctx.port, ctx.token);

      expect(readFileSync(ctx.file, "utf8")).toBe(before);
      expect(readFileSync(ctx.file, "utf8")).toContain("dns-prefetch");
    }, foreignSeed(PREFETCH_DOC));
  });

  it("should serve prefetch links untouched when network is on", async () => {
    await withServer(async (ctx) => {
      const granted = await postPermissions(ctx.port, ctx.token, { network: true });
      expect(granted.status).toBe(200);

      const res = await serveDoc(ctx.port, ctx.token);
      expect(res.body).toContain("dns-prefetch");
      expect(res.body).toContain("preconnect");
      expect(res.body).toContain("modulepreload");
    }, foreignSeed(PREFETCH_DOC));
  });

  it("should serve a managed doc unchanged (no foreign stripping path)", async () => {
    await withServer(async (ctx) => {
      const res = await serveDoc(ctx.port, ctx.token);

      expect(res.status).toBe(200);
      expect(res.headers["x-dns-prefetch-control"]).toBe("off");
    });
  });
});

describe("stripPrefetchLinks · unit edge cases", () => {
  it("should return the same string when there are no prefetch links", () => {
    const html = "<!doctype html><html><head><title>x</title></head><body><p>t</p></body></html>";

    expect(stripPrefetchLinks(html)).toBe(html);
  });

  it("should strip case variants and multi-token rel values", () => {
    const html = [
      '<link REL="DNS-PREFETCH" href="//a">',
      '<link rel="preconnect stylesheet" href="//b">',
      '<link rel="ModulePreload" href="//c">',
      '<link rel="icon" href="favicon.ico">',
    ].join("");
    const out = stripPrefetchLinks(html);

    expect(out).not.toContain("//a");
    expect(out).not.toContain("//b");
    expect(out).not.toContain("//c");
    expect(out).toContain('rel="icon"');
  });

  it("should not touch links without rel or with unrelated rel values", () => {
    const html =
      '<link href="//a">' +
      '<link rel="stylesheet" href="style.css">' +
      '<link rel="alternate" type="application/rss+xml" href="rss.xml">';
    const out = stripPrefetchLinks(html);

    expect(out).toBe(html);
  });

  it("should survive malformed markup without throwing", () => {
    const html =
      '<link rel="dns-prefetch" href="//a"><link rel="preconnect" href="//b"><div unclosed';
    const out = stripPrefetchLinks(html);

    expect(out).not.toContain("//a");
    expect(out).not.toContain("//b");
  });

  it("should remove only the link element span and keep surrounding bytes", () => {
    const html = "<head>x<link rel='prefetch' href='//a'>y</head>";
    const out = stripPrefetchLinks(html);

    expect(out).toBe("<head>xy</head>");
  });
});
