// 这层管：watcher 的三条现实路径——自身写不回声、外部改去抖一次、rm 后重建不崩。

import { readFileSync, renameSync, rmSync } from "node:fs";
import { writeFileSync as writeText } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { cookieOf, httpCall, openSse, withServer } from "./harness";
import { withPost } from "./wire";

const append = async (port: number, token: string, text: string): Promise<number> => {
  const response = await httpCall(port, {
    method: "POST",
    path: "/api/patch",
    headers: withPost(token),
    body: JSON.stringify({
      docId: "doc.html",
      action: "append",
      targetId: "hr-d",
      // 行内片段才能落在 <p>（hr-d）里；块级会被内容模型校验拒掉。
      fragment: `<b>${text}</b>`,
    }),
  });
  return response.status;
};

const settle = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe("watcher · 自身写的回声", () => {
  it("should emit exactly one event per self write (no echo duplicates)", async () => {
    await withServer(async (ctx) => {
      const sse = openSse(ctx.port, "/api/events", { Cookie: cookieOf(ctx.token) });
      await sse.waitFor(1);
      // 每次写后等到"确实收到第 N 个 doc.changed"再写下一次：回声窗口与 100ms 去抖都不再靠 sleep 猜。
      for (const [index, text] of ["a", "b", "c"].entries()) {
        expect(await append(ctx.port, ctx.token, text)).toBe(200);
        const deadline = Date.now() + 3000;
        while (
          sse.frames.filter((frame) => frame.data.includes('"type":"doc.changed"')).length <
            index + 1 &&
          Date.now() < deadline
        ) {
          await settle(20);
        }
      }
      await settle(400);
      const changed = sse.frames.filter((frame) => frame.data.includes('"type":"doc.changed"'));
      const ids = sse.frames.map((frame) => frame.id);
      sse.close();

      // 每写一次至少一个，且绝不能出现"同一事件重放两遍"（客户端会重复渲染）。
      expect(changed.length).toBeGreaterThanOrEqual(3);
      expect(ids).toEqual(ids.map((_, index) => index));
      const payloads = changed.map((frame) => frame.data);
      for (let index = 1; index < payloads.length; index += 1) {
        expect(payloads[index]).not.toBe(payloads[index - 1]);
      }
    });
  });
});

describe("watcher · 外部改动", () => {
  it("should debounce an external write into a single doc.changed", async () => {
    await withServer(async (ctx) => {
      const opened = await httpCall(ctx.port, {
        path: "/api/doc/doc.html/model",
        headers: { cookie: cookieOf(ctx.token) },
      });
      expect(opened.status).toBe(200);
      const sse = openSse(ctx.port, "/api/events", { Cookie: cookieOf(ctx.token) });
      await sse.waitFor(1);
      writeText(ctx.file, readFileSync(ctx.file, "utf8").replace(">正文一<", ">外部一<"));
      const started = Date.now();
      while (
        !sse.frames.some((frame) => frame.data.includes('"type":"doc.changed"')) &&
        Date.now() - started < 3_000
      ) {
        await settle(50);
      }
      await settle(300);
      const changed = sse.frames.filter((frame) => frame.data.includes('"type":"doc.changed"'));
      sse.close();

      expect(changed).toHaveLength(1);
      expect(changed[0]?.data).toContain('"docId":"doc.html"');
    });
  });
});

describe("watcher · 外部改动（续）", () => {
  it("should survive an atomic replace (rm + recreate) without crashing", async () => {
    await withServer(async (ctx) => {
      const temp = join(ctx.workspace, "swap.tmp");
      writeText(temp, readFileSync(ctx.file, "utf8").replace(">正文二<", ">换掉<"));
      renameSync(temp, ctx.file);
      const response = await httpCall(ctx.port, {
        path: "/api/doc/doc.html/model",
        headers: { cookie: cookieOf(ctx.token) },
      });
      await settle(250);

      expect(response.status).toBe(200);
      expect(readFileSync(ctx.file, "utf8")).toContain("换掉");
    });
  });

  it("should keep serving when the document is missing, and recover after it returns", async () => {
    await withServer(async (ctx) => {
      rmSync(ctx.file);
      const missing = await httpCall(ctx.port, {
        path: "/api/doc/doc.html/model",
        headers: { cookie: cookieOf(ctx.token) },
      });
      writeText(ctx.file, '<article data-hr-id="hr-a"><p>回来了</p></article>');
      await settle(250);
      const back = await httpCall(ctx.port, {
        path: "/api/doc/doc.html/model",
        headers: { cookie: cookieOf(ctx.token) },
      });

      expect(missing.status).toBe(404);
      expect(back.status).toBe(200);
    });
  });
});
