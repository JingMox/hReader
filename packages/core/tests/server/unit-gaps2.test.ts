// 这层管：错误文案裁剪、重复 Host、watcher 去重、端口探测超时、非法百分号、keep-alive 空闲与 runtime 广播。

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { afterAll, describe, expect, it } from "vitest";

import { errorReply, HttpFault } from "../../src/server/http-io";
import { defaultHostsOf } from "../../src/server/auth";
import { startServer } from "../../src/server/server";
import { nodePatchDeps } from "../../src/io/node-fs";
import { nodeStyleDeps } from "../../src/style";
import { appendAnnotation, type AnnotationInput } from "../../src/server/annotation";
import { createWatcher } from "../../src/server/watcher";
import { portOpen } from "../../src/server/daemon";
import { watcherLike } from "./casts";
import { cookieOf, httpCall, openSse, rawExchange, withServer } from "./harness";

/** 写入时间戳由调用方从注入时钟取；纯函数层只透传，测试里用固定值保证字节级可比。 */
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const tmp = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};

const messageOf = (body: string | Uint8Array): string => {
  const text = typeof body === "string" ? body : Buffer.from(body).toString("utf8");
  const parsed: unknown = JSON.parse(text);
  const message: unknown = Reflect.get(Object(parsed), "message");
  return typeof message === "string" ? message : "";
};

describe("http-io · 公开文案的两道裁剪", () => {
  it("should hide absolute paths and truncate anything over 200 chars", () => {
    const pathy = errorReply(new HttpFault(400, "写入 /Users/someone/secret/dir/doc.html 失败"));
    expect(messageOf(pathy.body)).toBe("写入 [路径已隐藏] 失败");

    const long = errorReply(new HttpFault(400, "x".repeat(250)));
    expect(messageOf(long.body)).toHaveLength(201);
  });
});

describe("server · 多个 Host 头（解析器先拒，handler 分支不可达）", () => {
  it("should be rejected with 400 before our gate runs", async () => {
    await withServer(async (ctx) => {
      const text = await rawExchange(
        ctx.port,
        [
          "GET /api/status HTTP/1.1",
          `Host: 127.0.0.1:${String(ctx.port)}`,
          "Host: evil.example",
          `Cookie: ${cookieOf(ctx.token)}`,
          "",
          "",
        ].join("\r\n"),
        "HTTP/1.1",
        1500,
      );

      expect(text).toMatch(/^HTTP\/1\.1 400/u);
    });
  });
});

describe("auth · defaultHostsOf", () => {
  it("should advertise both loopback spellings for the given port", () => {
    expect(defaultHostsOf(6080)).toEqual(["127.0.0.1:6080", "localhost:6080"]);
  });
});

describe("annotation · meta 缺 annotations 键", () => {
  it("should treat a meta object without annotations as empty", () => {
    const html =
      '<article data-hr-id="hr-a"><p data-hr-id="hr-b">x</p></article><script id="hr-meta">{}</script>';

    const input: AnnotationInput = { start: 0, end: 1, text: "x", note: undefined, status: "open" };
    const outcome = appendAnnotation(html, input, "hr-note-new", CREATED_AT);

    expect(outcome.html).toContain('"id":"hr-note-new"');
  });
});

describe("watcher · 重复 add 同一目录", () => {
  it("should not attach a second watcher for the same dir/file key", () => {
    let attached = 0;
    const watcher = createWatcher({ now: () => 0, onFileChange: () => undefined }, () => {
      attached += 1;
      return watcherLike();
    });

    watcher.add("/ws", "doc.html");
    watcher.add("/ws", "doc.html");
    watcher.close();

    expect(attached).toBe(1);
  });
});

describe("daemon · portOpen 的计时器臂", () => {
  it("should resolve false when the timeout fires before connect", async () => {
    await expect(portOpen(80, 0)).resolves.toBe(false);
  });
});

describe("server · 非法百分号编码", () => {
  it("should answer 400 for a path segment that is not valid percent-encoding", async () => {
    await withServer(async (ctx) => {
      const text = await rawExchange(
        ctx.port,
        `GET /s/%zz HTTP/1.1\r\nHost: 127.0.0.1:${String(ctx.port)}\r\nCookie: ${cookieOf(ctx.token)}\r\n\r\n`,
        "HTTP/1.1",
        1500,
      );

      expect(text).toMatch(/^HTTP\/1\.1 400/u);
    });
  });
});

describe("limits · keep-alive 空闲到点", () => {
  // v4#2：空闲到点只关连接，不再发 408（Node `keepAliveTimeout` 的语义）。
  it("should close without a 408 once the idle window elapses", async () => {
    await withServer(
      async (ctx) => {
        const socket = connect({ host: "127.0.0.1", port: ctx.port });
        const chunks: Buffer[] = [];
        let closed = false;
        await new Promise<void>((resolve) => {
          socket.on("connect", () => {
            socket.write(
              `GET /api/doc/doc.html/model HTTP/1.1\r\nHost: 127.0.0.1:${String(ctx.port)}\r\nCookie: ${cookieOf(ctx.token)}\r\nConnection: keep-alive\r\n\r\n`,
            );
          });
          socket.on("data", (chunk: Buffer) => chunks.push(chunk));
          socket.on("close", () => {
            closed = true;
            resolve();
          });
          setTimeout(() => {
            socket.destroy();
            resolve();
          }, 3000);
        });

        const raw = Buffer.concat(chunks).toString("latin1");
        expect(raw).toMatch(/^HTTP\/1\.1 200/u);
        expect(raw).not.toContain("408");
        expect(closed).toBe(true);
      },
      { headersMs: 200, bodyMs: 200, idleMs: 200 },
    );
  });
});

describe("runtime · 打开文档后的 library.changed", () => {
  it("should broadcast library.changed for another file while a doc is open", async () => {
    const workspace = tmp("hr-rt2-ws-");
    writeFileSync(join(workspace, "doc.html"), '<article data-hr-id="hr-a"><p>x</p></article>');
    writeFileSync(join(workspace, "other.html"), "<article><p>y</p></article>");
    const server = await startServer(
      { workspace, port: 0, home: tmp("hr-rt2-home-"), docId: "doc.html" },
      { patch: nodePatchDeps, style: nodeStyleDeps(workspace), now: Date.now },
    );
    const sse = openSse(server.port, "/api/events", { Cookie: cookieOf(server.token) });

    try {
      await sse.waitFor(1);
      await httpCall(server.port, {
        path: "/s/doc.html",
        headers: { cookie: cookieOf(server.token) },
      });
      writeFileSync(join(workspace, "other.html"), "<article><p>z</p></article>");
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && !sse.frames.some((f) => f.event === "library.changed")) {
        await new Promise((resolve) => {
          setTimeout(resolve, 25);
        });
      }

      expect(sse.frames.some((frame) => frame.event === "library.changed")).toBe(true);
    } finally {
      sse.close();
      await server.close();
    }
  });
});
