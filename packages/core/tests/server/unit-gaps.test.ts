// 这层管：错误映射与协议守卫的单点分支（500 兜底、TE 走私面、allowHosts 分支、帧头转义、诊断出口、bind 非 EADDRINUSE、405）。

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { HrError } from "../../src/hr-error";
import { createEventRing, frameOf } from "../../src/server/event-ring";
import type { SseEvent } from "../../src/server/contracts";
import { createHub, createServerHub } from "../../src/server/hub";
import { errorReply } from "../../src/server/http-io";
import { hostAllowed } from "../../src/server/auth";
import { startServer } from "../../src/server/server";
import { nodePatchDeps } from "../../src/io/node-fs";
import { nodeStyleDeps } from "../../src/style";
import { cookieOf, rawExchange, withServer } from "./harness";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const tmp = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};

describe("http-io · errorReply 的三条映射", () => {
  it("should map an unexpected Error to a 500 with a fixed public message", () => {
    const reply = errorReply(new Error("内部细节不要泄露"));

    expect(reply.status).toBe(500);
    expect(reply.body).toContain('"code":"io_failure"');
    expect(reply.body).not.toContain("内部细节");
  });

  it("should prefer the frozen message of a known HrError code", () => {
    const reply = errorReply(new HrError("node_not_found", "细节"));

    expect(reply.status).toBe(404);
    expect(reply.body).toContain('"code":"node_not_found"');
  });
});

describe("http-io · 走私面守卫（真 socket）", () => {
  const head = (port: number, token: string, extra: readonly string[]): string =>
    [
      "POST /api/patch HTTP/1.1",
      `Host: 127.0.0.1:${String(port)}`,
      `Cookie: ${cookieOf(token)}`,
      "X-HR-CSRF: 1",
      ...extra,
      "",
      "",
    ].join("\r\n");

  it("should reject Transfer-Encoding together with Content-Length (400)", async () => {
    await withServer(async (ctx) => {
      const text = await rawExchange(
        ctx.port,
        head(ctx.port, ctx.token, ["Transfer-Encoding: chunked", "Content-Length: 5", "0"]),
        "HTTP/1.1",
        1500,
      );

      expect(text).toMatch(/^HTTP\/1\.1 400/u);
    });
  });

  it("should reject a non-chunked Transfer-Encoding as a bad request", async () => {
    await withServer(async (ctx) => {
      const text = await rawExchange(
        ctx.port,
        head(ctx.port, ctx.token, ["Transfer-Encoding: gzip"]),
        "HTTP/1.1",
        1500,
      );

      expect(text).toMatch(/^HTTP\/1\.1 400/u);
    });
  });
});

describe("http-io · 方法不允许（405 + allow）", () => {
  it("should answer 405 and advertise the allowed methods", async () => {
    await withServer(async (ctx) => {
      const text = await rawExchange(
        ctx.port,
        [
          "PUT /api/patch HTTP/1.1",
          `Host: 127.0.0.1:${String(ctx.port)}`,
          `Cookie: ${cookieOf(ctx.token)}`,
          "X-HR-CSRF: 1",
          "",
          "",
        ].join("\r\n"),
        "HTTP/1.1",
        1500,
      );

      expect(text).toMatch(/^HTTP\/1\.1 405/u);
      expect(text.toLowerCase()).toContain("allow: ");
    });
  });
});

describe("auth · allowHosts 的三条分支", () => {
  it("should fall back to loopback for empty/absent lists and accept a custom list", () => {
    expect(hostAllowed(undefined, 6080)).toBe(false);
    expect(hostAllowed("127.0.0.1:6080", 6080, [])).toBe(true);
    expect(hostAllowed(" LocalHost:6080 ", 6080)).toBe(true);
    expect(hostAllowed("hr.local:6080", 6080, ["hr.local:6080"])).toBe(true);
    expect(hostAllowed("hr.local:6080", 6080, ["other:6080"])).toBe(false);
  });
});

describe("event-ring · 帧头转义与诊断出口", () => {
  it("should replace CR/LF in the type token and report it once", () => {
    const notes: string[] = [];
    const event: SseEvent = { id: 7, type: "doc\r\nchanged", payload: {} };

    const frame = frameOf(event, (message) => notes.push(message));

    expect(notes).toHaveLength(1);
    expect(frame.split("\n")).toHaveLength(4);
    expect(frame).not.toContain("doc\r\nchanged");
  });

  it("should keep the plain path silent", () => {
    const notes: string[] = [];
    const frame = frameOf({ id: 1, type: "doc.changed", payload: {} }, (message) =>
      notes.push(message),
    );

    expect(notes).toHaveLength(0);
    expect(frame).toContain('"type":"doc.changed"');
  });

  it("should sanitize without a note callback", () => {
    const frame = frameOf({ id: 3, type: "a\nb", payload: {} });

    expect(frame).toContain('"type":"a-b"');
  });
});

describe("hub · createServerHub 的两个 arity", () => {
  it("should build a hub with and without a diagnostic sink", () => {
    const plain = createServerHub();
    const noisy: string[] = [];
    const reported = createServerHub((message) => noisy.push(message));
    const ring = createEventRing(2);
    const hub = createHub({ ring, heartbeatMs: 60_000 });

    const pushed = reported.publish("doc.changed", { n: 1 });
    reported.close();
    hub.close();
    plain.close();

    expect(pushed.id).toBe(1);
    expect(noisy).toEqual([]);
    expect(ring.newest()).toBe(0);
  });
});

describe("server · bind 的非 EADDRINUSE 分支", () => {
  it("should surface the OS error unchanged when binding a privileged port", async () => {
    const workspace = tmp("hr-bind2-ws-");
    writeFileSync(
      join(workspace, "doc.html"),
      '<article data-hr-id="hr-a"><p>x</p></article>',
      "utf8",
    );

    await expect(
      startServer(
        { workspace, port: 80, home: tmp("hr-bind2-home-"), docId: "doc.html" },
        { patch: nodePatchDeps, style: nodeStyleDeps(workspace), now: Date.now },
      ),
    ).rejects.toMatchObject({ code: "EACCES" });
  });
});
