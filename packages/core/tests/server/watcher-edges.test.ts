// 这层管：watcher / runtime 状态的对抗用例——
// 只写未读的子目录文档丢外部编辑、remember 失败后 active 被改指、
// 外部 unlink/rename 的 doc.error、debounce 收敛为单次 doc.changed。

import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DOC, cookieOf, defaultSeed, httpCall, openSse, withServer } from "./harness";
import { withPost } from "./wire";

const subSeed = (workspace: string): void => {
  defaultSeed(workspace);
  mkdirSync(join(workspace, "sub"));
  writeFileSync(join(workspace, "sub", "inner.html"), DOC, "utf8");
};

const binSeed = (workspace: string): void => {
  defaultSeed(workspace);
  writeFileSync(join(workspace, "bin.html"), Buffer.from([0xff, 0xfe, 0x41]));
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe("watcher · 子目录文档只写未读", () => {
  it("should publish doc.changed when a write-only subdirectory doc is edited externally", async () => {
    await withServer(async (ctx) => {
      const patch = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/patch",
        headers: withPost(ctx.token),
        body: JSON.stringify({
          docId: "sub/inner.html",
          action: "append",
          targetId: "hr-d",
          fragment: "<b>x</b>",
        }),
      });
      expect(patch.status).toBe(200);
      const sse = openSse(ctx.port, "/api/events", { Cookie: cookieOf(ctx.token) });
      await sse.waitFor(1);
      // 越过自写回声窗口（ECHO_MS=200），否则改动被吞掉——同 lock-and-runtime.test.ts 的先例。
      await sleep(250);
      writeFileSync(
        join(ctx.workspace, "sub", "inner.html"),
        `${DOC}\r\n<!-- external -->`,
        "utf8",
      );
      const frame = await sse.waitForEvent("doc.changed");
      sse.close();

      expect(frame.data).toContain('"docId":"sub/inner.html"');
    }, subSeed);
  });
});

describe("watcher · remember 失败", () => {
  it("should keep tracking the previous active doc after remember fails on a binary doc", async () => {
    await withServer(async (ctx) => {
      const ok = await httpCall(ctx.port, {
        path: "/api/doc/doc.html/model",
        headers: { cookie: cookieOf(ctx.token) },
      });
      const bad = await httpCall(ctx.port, {
        path: "/api/doc/bin.html/model",
        headers: { cookie: cookieOf(ctx.token) },
      });
      const sse = openSse(ctx.port, "/api/events", { Cookie: cookieOf(ctx.token) });
      await sse.waitFor(1);
      writeFileSync(ctx.file, `${DOC}\r\n<!-- still active -->`, "utf8");
      const frame = await sse.waitForEvent("doc.changed");
      sse.close();

      expect(ok.status).toBe(200);
      expect(bad.status).toBe(500);
      expect(frame.data).toContain('"docId":"doc.html"');
    }, binSeed);
  });
});

describe("watcher · 外部删除与重命名", () => {
  it("should publish doc.error when the active file is unlinked externally", async () => {
    await withServer(async (ctx) => {
      await httpCall(ctx.port, {
        path: "/api/doc/doc.html/model",
        headers: { cookie: cookieOf(ctx.token) },
      });
      const sse = openSse(ctx.port, "/api/events", { Cookie: cookieOf(ctx.token) });
      await sse.waitFor(1);
      unlinkSync(ctx.file);
      const frame = await sse.waitForEvent("doc.error");
      sse.close();

      expect(frame.data).toContain('"path":"doc.html"');
    });
  });

  it("should publish doc.error on rename-away and doc.changed on a byte-different recreate", async () => {
    await withServer(async (ctx) => {
      await httpCall(ctx.port, {
        path: "/api/doc/doc.html/model",
        headers: { cookie: cookieOf(ctx.token) },
      });
      const sse = openSse(ctx.port, "/api/events", { Cookie: cookieOf(ctx.token) });
      await sse.waitFor(1);
      const moved = join(ctx.workspace, "moved.html");
      renameSync(ctx.file, moved);
      const errorFrame = await sse.waitForEvent("doc.error");
      // 同字节移回会被 revision 去抖吞掉（"字节没变才不发"）；编辑器式原子保存换的是新字节。
      writeFileSync(ctx.file, `${DOC}\r\n<!-- recreated -->`, "utf8");
      const changed = await sse.waitForEvent("doc.changed");
      sse.close();

      expect(errorFrame.data).toContain('"path":"doc.html"');
      expect(changed.data).toContain('"docId":"doc.html"');
    });
  });
});

describe("watcher · 快速连改", () => {
  it("should coalesce a burst of external edits into a single doc.changed carrying the final revision", async () => {
    await withServer(async (ctx) => {
      await httpCall(ctx.port, {
        path: "/api/doc/doc.html/model",
        headers: { cookie: cookieOf(ctx.token) },
      });
      const sse = openSse(ctx.port, "/api/events", { Cookie: cookieOf(ctx.token) });
      await sse.waitFor(1);
      const finalText = `${DOC}\r\n<!-- burst-final -->`;
      writeFileSync(ctx.file, `${DOC}\r\n<!-- burst-1 -->`, "utf8");
      writeFileSync(ctx.file, `${DOC}\r\n<!-- burst-2 -->`, "utf8");
      writeFileSync(ctx.file, finalText, "utf8");
      const frame = await sse.waitForEvent("doc.changed");
      sse.close();

      const { createHash } = await import("node:crypto");
      const revision = createHash("sha256").update(finalText, "utf8").digest("hex").slice(0, 16);
      expect(frame.data).toContain(`"revision":"${revision}"`);
      expect(sse.frames.filter((item) => item.event === "doc.changed")).toHaveLength(1);
    });
  });
});
