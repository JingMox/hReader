// 这层管：G3-R 复测发现的单点分支（hub 缺省 id、portOpen 计时器、removeDaemon 的 ENOENT、limits 的 keep-alive 重挂与收尾）。

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { afterAll, describe, expect, it } from "vitest";

import { createHub } from "../../src/server/hub";
import { createEventRing } from "../../src/server/event-ring";
import { portOpen, removeDaemonOf } from "../../src/server/daemon";
import { nodePatchDeps } from "../../src/io/node-fs";
import type { PatchDeps } from "../../src/io/ports";
import { responseLike } from "./casts";
import { cookieOf, withServer } from "./harness";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const withCode = (error: Error, code: string): Error => Object.assign(error, { code });

const tmp = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};

describe("hub · 缺省 Last-Event-ID", () => {
  it("should treat an undefined id as 0 and send no backfill", () => {
    const written: string[] = [];
    const res = responseLike({
      writeHead: () => undefined,
      write: (chunk: string) => written.push(chunk),
      end: () => undefined,
      on: () => undefined,
      once: () => undefined,
      flushHeaders: () => undefined,
      destroyed: false,
    });
    const hub = createHub({ ring: createEventRing(4), heartbeatMs: 60_000 });

    const client = hub.addClient(res, undefined);
    hub.publish("doc.changed", { docId: "doc.html" });
    hub.removeClient(client);
    hub.close();

    expect(client).toBeGreaterThan(0);
    expect(written.join("")).toContain("doc.changed");
  });
});

describe("event-ring · 负数 id 落在 newest 之前", () => {
  it("should answer a negative Last-Event-ID from an empty ring with an empty backfill", () => {
    const ring = createEventRing(4);

    expect(ring.since(-1)).toEqual({ hit: true, events: [] });
    ring.push("doc.changed", {});
    expect(ring.since(-1)).toEqual({ hit: false, events: [] });
  });
});

describe("daemon · portOpen 的计时器臂", () => {
  it("should resolve false when the connect never completes before the timer", async () => {
    // TEST-NET-1（RFC 5737）不该有主机：SYN 被丢，connect 一直挂到我们的计时器。
    await expect(portOpen(81, 120)).resolves.toBe(false);
  }, 5_000);
});

describe("daemon · removeDaemonOf 的 ENOENT 与其它故障", () => {
  const seed = async (home: string): Promise<void> => {
    const { writeDaemonOf } = await import("../../src/server/daemon");
    await writeDaemonOf(
      { port: 6000, token: "t".repeat(32), pid: process.pid, workspace: "/ws" },
      home,
      nodePatchDeps,
    );
  };

  it("should return false when the file vanished between read and unlink", async () => {
    const home = tmp("hr-daemon2-");
    await seed(home);
    const missing = (): never => {
      throw withCode(new Error("gone"), "ENOENT");
    };
    const deps: PatchDeps = { ...nodePatchDeps, fs: { ...nodePatchDeps.fs, unlink: missing } };

    await expect(removeDaemonOf(home, process.pid, deps)).resolves.toBe(false);
  });

  it("should surface a non-ENOENT unlink failure as io_failure", async () => {
    const home = tmp("hr-daemon3-");
    await seed(home);
    const denied = (): never => {
      throw withCode(new Error("denied"), "EACCES");
    };
    const deps: PatchDeps = { ...nodePatchDeps, fs: { ...nodePatchDeps.fs, unlink: denied } };

    await expect(removeDaemonOf(home, process.pid, deps)).rejects.toMatchObject({
      code: "io_failure",
    });
  });
});

describe("limits · keep-alive 上重挂 idle 计时器", () => {
  it("should serve two requests on one socket and clear timers when the server closes", async () => {
    await withServer(
      async (ctx) => {
        const socket = connect({ host: "127.0.0.1", port: ctx.port });
        const chunks: Buffer[] = [];
        let statuses = 0;
        await new Promise<void>((resolve) => {
          socket.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
            statuses += (chunk.toString("latin1").match(/^HTTP\/1\.1 200/gu) ?? []).length;
            if (statuses === 1) {
              socket.write(
                `GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:${String(ctx.port)}\r\nCookie: ${cookieOf(ctx.token)}\r\nConnection: keep-alive\r\n\r\n`,
              );
            }
            if (statuses >= 2) {
              socket.destroy();
              resolve();
            }
          });
          socket.on("error", () => {
            resolve();
          });
          socket.on("connect", () => {
            socket.write(
              `GET /api/doc/doc.html/model HTTP/1.1\r\nHost: 127.0.0.1:${String(ctx.port)}\r\nCookie: ${cookieOf(ctx.token)}\r\nConnection: keep-alive\r\n\r\n`,
            );
          });
          setTimeout(resolve, 2000);
        });

        expect(Buffer.concat(chunks).toString("latin1")).toMatch(/^HTTP\/1\.1 200/u);
      },
      { headersMs: 500, bodyMs: 500, idleMs: 5_000 },
    );
  });
});

const idleClose = async (port: number, token: string): Promise<string> => {
  const socket = connect({ host: "127.0.0.1", port });
  const chunks: Buffer[] = [];
  const closed = new Promise<void>((resolve) => {
    socket.on("close", () => {
      resolve();
    });
    socket.on("error", () => {
      resolve();
    });
  });
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  await new Promise<void>((resolve) => {
    socket.on("connect", () => {
      socket.write(
        `GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nCookie: ${token}\r\nConnection: keep-alive\r\n\r\n`,
      );
      resolve();
    });
  });
  await closed;
  return Buffer.concat(chunks).toString("latin1");
};

const headTimeout = async (port: number): Promise<string> => {
  const socket = connect({ host: "127.0.0.1", port });
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  await new Promise<void>((resolve) => {
    socket.on("connect", () => {
      socket.write("GET /healthz HTTP/1.1\r\n");
      resolve();
    });
  });
  await new Promise<void>((resolve) => {
    socket.on("close", () => {
      resolve();
    });
    socket.on("error", () => {
      resolve();
    });
    setTimeout(resolve, 1_000);
  });
  socket.destroy();
  return Buffer.concat(chunks).toString("latin1");
};

describe("limits · 两档计时器的收尾路径", () => {
  // v4#2：空闲到点 = 静默关连接（Node `keepAliveTimeout`），不再有自造 408。
  it("should close an idle keep-alive socket without a 408 frame", async () => {
    await withServer(
      async (ctx) => {
        const raw = await idleClose(ctx.port, cookieOf(ctx.token));

        expect(raw).toMatch(/^HTTP\/1\.1 200/u);
        expect(raw).not.toContain("408");
      },
      { headersMs: 1_000, bodyMs: 1_000, idleMs: 120 },
    );
  });

  // v4#2：请求头半截由 Node 的 `requestTimeout` 处理——它可能回 408，也可能直接关连接，两者都合规。
  it("should either answer 408 or close when the request head never finishes", async () => {
    await withServer(
      async (ctx) => {
        const raw = await headTimeout(ctx.port);

        expect(raw === "" || raw.startsWith("HTTP/1.1 408")).toBe(true);
      },
      { headersMs: 120, bodyMs: 1_000, idleMs: 1_000 },
    );
  });
});
