// 这层管：陈旧 daemon 判定——死 pid 只删记录不阻断、活持有者仍拒绝、`isAlive` 注入的边界值不崩。

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { daemonFileOf, readDaemonOf, staleDaemonOf, writeDaemonOf } from "../../src/server/daemon";
import { startServer } from "../../src/server/server";
import { nodePatchDeps } from "../../src/io/node-fs";
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

const seedDoc = (workspace: string): void => {
  writeFileSync(
    join(workspace, "doc.html"),
    '<article data-hr-id="hr-a"><p data-hr-id="hr-b">x</p></article>',
    "utf8",
  );
};

const listenOn = async (
  handler?: RequestListener,
): Promise<{ port: number; close: () => Promise<void> }> => {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    port: typeof address === "object" && address !== null ? address.port : 0,
    close: (): Promise<void> =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
};

describe("staleDaemonOf · isAlive 注入的边界", () => {
  const info = (pid: number): { port: number; token: string; pid: number; workspace: string } => ({
    port: 6001,
    token: "t".repeat(32),
    pid,
    workspace: "/ws",
  });

  it.each([0, 1, 2 ** 31 - 1, -3])(
    "should not crash and follow the injected isAlive (pid %i)",
    (pid) => {
      expect(staleDaemonOf(info(pid), () => true)).toBe(false);
      expect(staleDaemonOf(info(pid), () => false)).toBe(true);
    },
  );

  it("should use the real probe by default", () => {
    expect(staleDaemonOf(info(2 ** 31 - 1))).toBe(true);
  });
});

describe("ensureNoDaemon · 陈旧记录", () => {
  it("should delete a dead holder's record, log once, and start normally", async () => {
    const workspace = tmp("hr-stale-ws-");
    seedDoc(workspace);
    const home = tmp("hr-stale-home-");
    await writeDaemonOf(
      { port: 9, token: "t".repeat(32), pid: 2 ** 31 - 1, workspace },
      home,
      nodePatchDeps,
    );
    const notes: string[] = [];
    const server = await startServer(
      { workspace, port: 0, home, docId: "doc.html", diagnose: (m) => notes.push(m) },
      { patch: nodePatchDeps, style: nodeStyleDeps(workspace), now: Date.now },
    );

    try {
      const fresh = await readDaemonOf(home, nodePatchDeps);
      expect(fresh?.pid).toBe(process.pid);
      expect(fresh?.port).toBe(server.port);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain("清理陈旧 daemon.json");
      expect(readFileSync(daemonFileOf(home), "utf8")).toContain(String(process.pid));
    } finally {
      await server.close();
    }
  });
});

describe("ensureNoDaemon · 活持有者", () => {
  it("should refuse with daemon_already_running when /healthz names the recorded pid", async () => {
    const workspace = tmp("hr-alive-ws-");
    seedDoc(workspace);
    const home = tmp("hr-alive-home-");
    // 身份探测问的就是 `/healthz`：它回同一 pid，才证明“端口上确实是这份记录里的 daemon”。
    const live = await listenOn((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ pid: process.pid }));
    });

    try {
      await writeDaemonOf(
        { port: live.port, token: "t".repeat(32), pid: process.pid, workspace },
        home,
        nodePatchDeps,
      );

      await expect(
        startServer(
          { workspace, port: 0, home, docId: "doc.html" },
          { patch: nodePatchDeps, style: nodeStyleDeps(workspace), now: Date.now },
        ),
      ).rejects.toMatchObject({ code: "daemon_already_running" });
      const kept = await readDaemonOf(home, nodePatchDeps);
      expect(kept?.pid).toBe(process.pid);
    } finally {
      await live.close();
    }
  });
});

describe("ensureNoDaemon · 端口被占但不是 daemon", () => {
  it("should report port_in_use when the port answers but not as our daemon", async () => {
    const workspace = tmp("hr-unknown-ws-");
    seedDoc(workspace);
    const home = tmp("hr-unknown-home-");
    // 裸 TCP 监听：连得上、不应答 `/healthz`。探不到身份 ⇒ 不能断言“是我们的 daemon 还活着”，
    // 按占用报（后手是换 `--port`），也不许删掉记录。
    const silent = await listenOn();

    try {
      await writeDaemonOf(
        { port: silent.port, token: "t".repeat(32), pid: process.pid, workspace },
        home,
        nodePatchDeps,
      );

      await expect(
        startServer(
          { workspace, port: 0, home, docId: "doc.html" },
          { patch: nodePatchDeps, style: nodeStyleDeps(workspace), now: Date.now },
        ),
      ).rejects.toMatchObject({ code: "port_in_use" });
      expect((await readDaemonOf(home, nodePatchDeps))?.pid).toBe(process.pid);
    } finally {
      await silent.close();
    }
  });
});

describe("ensureNoDaemon · 端口上不是我们", () => {
  it("should drop the record and start when /healthz names another pid", async () => {
    const workspace = tmp("hr-foreign-ws-");
    seedDoc(workspace);
    const home = tmp("hr-foreign-home-");
    // 记录里的 pid 被无关进程复用了：`/healthz` 能答但不是这一个 pid ⇒ 旧记录已作废（kill -9 的残骸、别的工具写的同名文件）。
    const foreign = await listenOn((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ pid: 1 }));
    });
    await writeDaemonOf(
      { port: foreign.port, token: "t".repeat(32), pid: process.pid, workspace },
      home,
      nodePatchDeps,
    );
    const rows: string[] = [];

    const server = await startServer(
      { workspace, port: 0, home, docId: "doc.html", diagnose: (row) => rows.push(row) },
      { patch: nodePatchDeps, style: nodeStyleDeps(workspace), now: Date.now },
    );
    try {
      expect(server.port).toBeGreaterThan(0);
      // 旧记录被删掉（新的那份由本次启动自己写，端口是新绑的那个，不是 foreign.port）。
      expect((await readDaemonOf(home, nodePatchDeps))?.port).toBe(server.port);
      expect(rows.join("")).toContain(`127.0.0.1:${String(foreign.port)} 上不是 hReader`);
    } finally {
      await server.close();
      await foreign.close();
    }
  });
});

describe("ensureNoDaemon · 残骸", () => {
  it("should treat an alive pid with a silent port as a crash remnant and start", async () => {
    const workspace = tmp("hr-remnant-ws-");
    seedDoc(workspace);
    const home = tmp("hr-remnant-home-");
    const silent = await listenOn();
    await silent.close();
    await writeDaemonOf(
      { port: silent.port, token: "t".repeat(32), pid: process.pid, workspace },
      home,
      nodePatchDeps,
    );

    const server = await startServer(
      { workspace, port: 0, home, docId: "doc.html" },
      { patch: nodePatchDeps, style: nodeStyleDeps(workspace), now: Date.now },
    );
    try {
      expect(server.port).toBeGreaterThan(0);
      expect(dirname(daemonFileOf(home))).toContain(".hreader");
    } finally {
      await server.close();
    }
  });
});
