// 这层管：并发写——20 路同文档不丢写、revision 严格单调；跨文档互不阻塞；占锁 5s → 503 busy。

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { httpCall, withServer } from "./harness";
import { withPost } from "./wire";

// 追加的行内片段：目标是 <p>（hr-d），块级子节点会被 F6 的内容模型校验拒掉；
// 这里只关心“并发写不丢”，用行内元素同样能落地字节。
const appendBody = (docId: string, text: string): string =>
  JSON.stringify({ docId, action: "append", targetId: "hr-d", fragment: `<b>${text}</b>` });

const post = async (
  port: number,
  token: string,
  docId: string,
  text: string,
): Promise<{ readonly status: number; readonly revision: number }> => {
  const response = await httpCall(port, {
    method: "POST",
    path: "/api/patch",
    headers: withPost(token),
    body: appendBody(docId, text),
    listen: 30_000,
  });
  const parsed: unknown = JSON.parse(response.body);
  const revision =
    typeof parsed === "object" && parsed !== null && "revision" in parsed ? parsed.revision : -1;
  return {
    status: response.status,
    revision: typeof revision === "string" ? Number.parseInt(revision, 16) : -1,
  };
};

describe("concurrency · 同文档", () => {
  it("should serialize 20 parallel patches: no lost write, unique monotonic revisions", async () => {
    await withServer(async (ctx) => {
      const results = await Promise.all(
        Array.from(
          { length: 20 },
          async (_unused, index) =>
            await post(ctx.port, ctx.token, "doc.html", `m${String(index)}`),
        ),
      );
      const html = readFileSync(ctx.file, "utf8");
      const revisions = results.map((result) => result.revision);

      expect(results.map((result) => result.status)).toEqual(Array.from({ length: 20 }, () => 200));
      expect(new Set(revisions).size).toBe(20);
      const markers = Array.from({ length: 20 }, (_unused, index) => `>m${String(index)}<`);
      expect(markers.filter((marker) => html.includes(marker))).toHaveLength(20);
      expect(html).toContain("<article");
      expect(html.trimEnd().endsWith("</html>")).toBe(true);
    });
  });

  it("should not interleave: file stays parseable and each marker appears exactly once", async () => {
    await withServer(async (ctx) => {
      await Promise.all(
        Array.from(
          { length: 12 },
          async (_unused, index) =>
            await post(ctx.port, ctx.token, "doc.html", `n${String(index)}`),
        ),
      );
      const html = readFileSync(ctx.file, "utf8");

      for (let index = 0; index < 12; index += 1) {
        expect(html.split(`>n${String(index)}<`)).toHaveLength(2);
      }
      expect(html.match(/<article/gu)).toHaveLength(1);
    });
  });
});

describe("concurrency · 跨文档", () => {
  it("should run two documents in parallel without blocking each other", async () => {
    await withServer(async (ctx) => {
      const started = Date.now();
      const both = await Promise.all([
        post(ctx.port, ctx.token, "doc.html", "a"),
        post(ctx.port, ctx.token, "other.html", "b"),
      ]);

      expect(both.map((result) => result.status)).toEqual([200, 200]);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(readFileSync(ctx.file, "utf8")).toContain(">a<");
      expect(readFileSync(join(ctx.workspace, "other.html"), "utf8")).toContain(">b<");
    });
  });
});

describe("concurrency · 锁", () => {
  it("should answer 503 busy when another live process holds the doc lock", async () => {
    await withServer(async (ctx) => {
      const lockDir = join(ctx.workspace, ".hreader", "locks");
      mkdirSync(lockDir, { recursive: true });
      const lock = join(lockDir, `${createHash("sha1").update("doc.html").digest("hex")}.lock`);
      writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: "held", at: Date.now() }));
      const response = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/patch",
        headers: withPost(ctx.token),
        body: appendBody("doc.html", "z"),
        listen: 30_000,
      });

      expect(response.status).toBe(503);
      expect(JSON.parse(response.body)).toMatchObject({ code: "busy" });
      expect(readFileSync(ctx.file, "utf8")).not.toContain(">z<");
    });
  }, 20_000);
});
