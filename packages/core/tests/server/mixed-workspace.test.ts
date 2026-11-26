// 这层管：startServer 在混有托管/外来/损坏/空/二进制伪装 .html 的工作区照常启动，
// 以及 close() 之后所有 watcher 句柄被释放（不泄漏、不报错）。

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { nodePatchDeps } from "../../src/io/node-fs";
import { startServer } from "../../src/server/server";
import type { WatchFn } from "../../src/server/watcher";
import { nodeStyleDeps } from "../../src/style";
import { cookieOf, DOC, httpCall, jsonBodyOf } from "./harness";

const FOREIGN =
  '<!doctype html><html><body><div class="app"><script>1</script>外来</div></body></html>';

/** 损坏 UTF-8、空文件、PNG 头伪装 .html——任何一个把启动/首页拖死都是回归。 */
const mixedSeed = (workspace: string): void => {
  writeFileSync(join(workspace, "doc.html"), DOC, "utf8");
  writeFileSync(join(workspace, "foreign.html"), FOREIGN, "utf8");
  writeFileSync(join(workspace, "corrupt.html"), Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x61]));
  writeFileSync(join(workspace, "empty.html"), "", "utf8");
  writeFileSync(
    join(workspace, "binary.html"),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  mkdirSync(join(workspace, "sub"));
  writeFileSync(join(workspace, "sub", "nested.html"), DOC, "utf8");
};

const withMixedServer = async (
  run: (ctx: {
    readonly workspace: string;
    readonly port: number;
    readonly token: string;
    readonly server: Awaited<ReturnType<typeof startServer>>;
  }) => Promise<void>,
  watch?: WatchFn,
): Promise<void> => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "hr-mix-ws-")));
  const home = realpathSync(mkdtempSync(join(tmpdir(), "hr-mix-home-")));
  mixedSeed(workspace);
  const server = await startServer(
    { workspace, port: 0, home, docId: "doc.html" },
    {
      patch: nodePatchDeps,
      style: nodeStyleDeps(workspace),
      now: Date.now,
      ...(watch === undefined ? {} : { watch }),
    },
  );
  try {
    await run({ workspace, port: server.port, token: server.token, server });
  } finally {
    await server.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
};

describe("startServer · 混合工作区", () => {
  it("should start and serve healthz/home/doc despite corrupt, empty, and binary siblings", async () => {
    await withMixedServer(async ({ port, token }) => {
      const health = await httpCall(port, { path: "/healthz" });
      expect(health.status).toBe(200);

      const home = await httpCall(port, { path: "/", headers: { cookie: cookieOf(token) } });
      expect(home.status).toBe(200);

      const doc = await httpCall(port, {
        path: "/s/doc.html",
        headers: { cookie: cookieOf(token) },
      });
      expect(doc.status).toBe(200);
      // 托管文档的 CSP 靠 default-src 'none' 关死脚本，不带 sandbox——
      // sandbox 两档只对外来文档下发。
      const docCsp = String(doc.headers["content-security-policy"]);
      expect(docCsp).toContain("default-src 'none'");
      expect(docCsp).not.toContain("sandbox");

      // 损坏 UTF-8 与二进制伪装 .html：status.ts 刻意把 invalid_utf8 映射成 500
      // （"客户端改不对"的错），要钉的是**结构化错误而不是崩溃**——服务还得照常应答。
      const corrupt = await httpCall(port, {
        path: "/s/corrupt.html",
        headers: { cookie: cookieOf(token) },
      });
      expect(corrupt.status).toBe(500);
      expect(jsonBodyOf(corrupt)).toMatchObject({ code: "invalid_utf8" });
      const binary = await httpCall(port, {
        path: "/s/binary.html",
        headers: { cookie: cookieOf(token) },
      });
      expect(binary.status).toBe(500);
      expect(jsonBodyOf(binary)).toMatchObject({ code: "invalid_utf8" });

      const after = await httpCall(port, { path: "/healthz" });
      expect(after.status).toBe(200);
    });
  });
});

describe("startServer · watcher 生命周期", () => {
  it("should close every watch handle when the server closes", async () => {
    const handles: { closed: boolean }[] = [];
    const events: ((event: string, name: string | undefined) => void)[] = [];
    const watch: WatchFn = (_dir, onEvent) => {
      events.push(onEvent);
      const handle = {
        closed: false,
        close: () => {
          handle.closed = true;
        },
      };
      handles.push(handle);
      return handle;
    };

    // 启动即监听 workspace（书库档）；fixture 的 finally 走真 close()。
    await withMixedServer(() => Promise.resolve(), watch);

    expect(handles.length).toBeGreaterThan(0);
    for (const handle of handles) expect(handle.closed).toBe(true);
  });
});
