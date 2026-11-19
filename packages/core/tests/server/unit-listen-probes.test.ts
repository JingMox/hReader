// 这层管：`listen.ts` 的两道端口探测（身份、IPv6 占用）与 `server.ts` 里那条"v6 被占只提示"的臂。
//
// 都是"端口的另一头不由我们控制"的分支：真实反弹一个监听器比 mock `node:http` 更能表达症状。

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { nodePatchDeps } from "../../src/io/node-fs";
import { ipv6Occupied, ownerOfPort } from "../../src/server/listen";
import { startServer } from "../../src/server/server";
import { nodeStyleDeps } from "../../src/style";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const tmp = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};

const listen = async (
  target: number | { readonly port: number; readonly host: string; readonly ipv6Only?: boolean },
): Promise<Server> => {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(typeof target === "number" ? { port: target } : target, resolve);
  });
  return server;
};

const close = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });

describe("ownerOfPort · 答了但不是我们的 /healthz", () => {
  it("should answer other when the health body is not JSON at all", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("<html>另一个工具的主页</html>");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    try {
      // 非 JSON = 不是我们的 `/healthz`（pidOfHealth 的 catch 臂），可以断言"不是你"。
      expect(await ownerOfPort({ port, token: "t".repeat(32), pid: 12345, workspace: "/ws" })).toBe(
        "other",
      );
    } finally {
      await close(server);
    }
  });
});

describe("ownerOfPort · 开着但没在听（或听的不是 http）", () => {
  it("should answer other when the health body is JSON but not an object (e.g. a bare number)", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("42");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    try {
      // 合法 JSON 但没有 pid 字段：另一个工具也可能回 JSON，不能因此认成"是我们的"。
      expect(await ownerOfPort({ port, token: "t".repeat(32), pid: 12345, workspace: "/ws" })).toBe(
        "other",
      );
    } finally {
      await close(server);
    }
  });

  it("should answer unknown when nothing is listening (timeout/连不上都不删记录)", async () => {
    const probe = await listen(0);
    const address = probe.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    await close(probe);

    expect(await ownerOfPort({ port, token: "t".repeat(32), pid: 1, workspace: "/ws" })).toBe(
      "unknown",
    );
  });
});

describe("ipv6Occupied · 只是补充信息", () => {
  it("should be false when the port is free", async () => {
    const probe = await listen({ port: 0, host: "127.0.0.1" });
    const address = probe.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    await close(probe);

    expect(await ipv6Occupied(port)).toBe(false);
  });

  it("should be true when a v6-only listener holds the port", async () => {
    const v6 = await listen({ port: 0, host: "::", ipv6Only: true });
    const address = v6.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    try {
      expect(await ipv6Occupied(port)).toBe(true);
    } finally {
      await close(v6);
    }
  });
});

describe("server · :: 上已有监听时只提示不拦", () => {
  it("should start on v4 and print the IPv6 advisory row", async () => {
    const workspace = tmp("hr-v6-ws-");
    writeFileSync(
      join(workspace, "doc.html"),
      '<article data-hr-id="hr-a"><p data-hr-id="hr-b">x</p></article>',
      "utf8",
    );
    const home = tmp("hr-v6-home-");
    // v6-only 先占住这个端口：v4 仍能绑（探测的前提），但经 IPv6 访问的流量会被它接走。
    const v6 = await listen({ port: 0, host: "::", ipv6Only: true });
    const address = v6.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const rows: string[] = [];

    const server = await startServer(
      {
        workspace,
        port,
        home,
        docId: "doc.html",
        diagnose: (row: string) => {
          rows.push(row);
        },
      },
      { patch: nodePatchDeps, style: nodeStyleDeps(workspace), now: Date.now },
    );
    try {
      expect(server.port).toBe(port);
      expect(rows.join("")).toContain(`注意：:: 上已有监听，经 IPv6 访问端口 ${String(port)}`);
    } finally {
      await server.close();
      await close(v6);
    }
  });
});
