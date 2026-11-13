// 这层管：进程内启停——端口释放、daemon.json 删除、fd 不泄漏。

import { connect } from "node:net";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { nodePatchDeps } from "../../src/io/node-fs";
import { nodeStyleDeps } from "../../src/style";
import { startServer } from "../../src/server/server";
import { withServer } from "./harness";

const fdCount = (): number => readdirSync("/dev/fd").length;

const portClosed = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(1000);
    socket.on("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => {
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });

describe("lifecycle · 关闭", () => {
  it("should free the port and delete daemon.json on close", async () => {
    await withServer(async (ctx) => {
      const daemon = join(ctx.home, ".hreader", "daemon.json");
      expect(existsSync(daemon)).toBe(true);
      await ctx.server.close();

      expect(existsSync(daemon)).toBe(false);
      expect(await portClosed(ctx.port)).toBe(true);
    });
  });

  it("should not leak file descriptors across start/close cycles", async () => {
    const before = fdCount();
    for (let round = 0; round < 3; round += 1) {
      await withServer(async (ctx) => {
        await ctx.server.close();
      });
    }
    const after = fdCount();

    expect(after).toBeLessThanOrEqual(before + 2);
  });
});

describe("lifecycle · 关闭（续）", () => {
  it("should refuse to start twice on the same home (daemon_already_running)", async () => {
    await withServer(async (ctx) => {
      await expect(
        startServer(
          { workspace: ctx.workspace, port: 0, home: ctx.home, docId: "doc.html" },
          { patch: nodePatchDeps, style: nodeStyleDeps(ctx.workspace), now: Date.now },
        ),
      ).rejects.toMatchObject({ code: "daemon_already_running" });
    });
  });
});
