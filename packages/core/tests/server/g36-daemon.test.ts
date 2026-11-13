// 这层管：R3 的陈旧 daemon 判定——死 pid 只删记录不阻断、活持有者仍拒绝、`isAlive` 注入的边界值不崩。

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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

const listenOn = async (): Promise<{ port: number; close: () => Promise<void> }> => {
  const server = createServer();
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
  it("should still refuse when the holder is alive and its recorded port answers", async () => {
    const workspace = tmp("hr-alive-ws-");
    seedDoc(workspace);
    const home = tmp("hr-alive-home-");
    const live = await listenOn();

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
