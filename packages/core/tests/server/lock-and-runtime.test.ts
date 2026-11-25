// 这层管：锁的 CAS 防线与 runtime 的守门分支——锁的两处 CAS、无活动文档的库变更、默认文档回落、首次发布。

import type { FileSystem } from "../../src/io/ports";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { nodePatchDeps } from "../../src/io/node-fs";
import { acquireLock } from "../../src/io/lock";
import { resolveTarget } from "../../src/io/paths";
import type { SseEvent } from "../../src/server/contracts";
import { createEventRing } from "../../src/server/event-ring";
import { createHub } from "../../src/server/hub";
import type { Runtime } from "../../src/server/runtime";
import { createRuntime } from "../../src/server/runtime";
import { nodeStyleDeps } from "../../src/style";
import { depsOf, fakeFs, fixedClock, recordingSleep } from "../io/harness";
import { requestLike, watcherLike } from "./casts";

const NOW = 1_700_000_000_000;
const LOCK = "/ws/.hreader/locks/lock.lock";
const OTHERS = "others000002";
const DOC = '<article data-hr-id="hr-a"><p data-hr-id="hr-b">一</p></article>';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const tmp = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};
const payloadText = (nonce: string, pid: number): string =>
  JSON.stringify({ pid, nonce, at: NOW - 60_000 });

/** 包一层 fs：`rename` 之后把 `stealPath` 的内容换成别人的 nonce（模拟判定与移走之间被换锁）。 */
const fsWithSwap = (base: FileSystem, lock: string, stealNonce: string): FileSystem => ({
  ...base,
  rename: async (from, to) => {
    await base.rename(from, to);
    if (from === lock)
      await base.writeFile(to, new TextEncoder().encode(payloadText(stealNonce, 1)));
  },
});

const ringOf = (): {
  ring: ReturnType<typeof createEventRing>;
  hub: ReturnType<typeof createHub>;
} => {
  const ring = createEventRing(16);
  return { ring, hub: createHub({ ring, heartbeatMs: 60_000 }) };
};

const waitFor = async (ready: () => boolean, budgetMs = 3000): Promise<void> => {
  const deadline = Date.now() + budgetMs;
  while (!ready() && Date.now() < deadline) {
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
};

describe("lock · 抢锁副本的 CAS 不符", () => {
  it("should drop the moved copy and re-create instead of writing the stale payload back", async () => {
    const fake = fakeFs({ "/ws/a.html": "x", [LOCK]: payloadText("staleaaa", 999_999) });
    const local = fixedClock(NOW);
    const fs = fsWithSwap(fake.port, LOCK, OTHERS);

    const handle = await acquireLock(
      { path: LOCK, timeoutMs: 50 },
      depsOf(fs, local.clock, recordingSleep(local).sleep),
    );

    // 抢锁失败后回主循环：锁位置已被腾空，于是正常创建，写的是自己的 nonce。
    expect(fake.textAt(LOCK)).not.toContain("staleaaa");
    expect(fake.textAt(LOCK)).not.toContain(OTHERS);
    expect([...fake.state.files.keys()].some((path) => path.includes(".steal-"))).toBe(false);
    await handle.release();
  });
});

describe("lock · 取得后被接管", () => {
  it("should throw locked when the first read after create returns a foreign nonce", async () => {
    const fake = fakeFs({ "/ws/a.html": "x" });
    const local = fixedClock(NOW);
    let reads = 0;
    const base = fake.port;
    const fs: FileSystem = {
      ...base,
      readFile: async (path) => {
        if (path === LOCK && reads === 0) {
          reads += 1;
          return new TextEncoder().encode(payloadText(OTHERS, 1));
        }
        return await base.readFile(path);
      },
    };

    const attempt = acquireLock(
      { path: LOCK, timeoutMs: 0 },
      depsOf(fs, local.clock, recordingSleep(local).sleep),
    );

    // 拿到锁之后才发现 nonce 不是自己的：必须抛 locked，而不是把 release 交出去。
    await expect(attempt).rejects.toMatchObject({ code: "locked" });
    expect(reads).toBe(1);
    expect(fake.textAt(LOCK)).not.toContain(OTHERS);
  });
});

describe("runtime · 没有活动文档时的库变更", () => {
  it("should publish library.changed and never doc.changed before any document is opened", async () => {
    const workspace = tmp("hr-nodoc-ws-");
    writeFileSync(join(workspace, "loose.html"), DOC, "utf8");
    const { ring, hub } = ringOf();
    let fire: ((event: string, name: string | undefined) => void) | undefined;
    const runtime = createRuntime(
      { workspace, docId: "doc.html", bodyMs: 200 },
      {
        patch: nodePatchDeps,
        style: nodeStyleDeps(workspace),
        watch: (_dir, onEvent) => {
          fire = onEvent;
          return watcherLike();
        },
      },
      hub,
    );

    try {
      fire?.("change", "loose.html"); // 不调用 remember：active 仍是 undefined。
      await waitFor(() => ring.since(0).events.length > 0);
      const events: readonly SseEvent[] = ring.since(0).events;

      expect(events[0]?.type).toBe("library.changed");
      expect(events.some((event) => event.type === "doc.changed")).toBe(false);
      expect(JSON.stringify(events[0]?.payload)).toContain("loose.html");
    } finally {
      runtime.close();
      hub.close();
    }
  });
});

describe("runtime · 路由没带 docId 参数时回落默认文档", () => {
  it("should fall back to options.docId when params omit docId", async () => {
    const workspace = tmp("hr-docid-ws-");
    writeFileSync(join(workspace, "doc.html"), DOC, "utf8");
    const { hub } = ringOf();
    const runtime = createRuntime(
      { workspace, docId: "doc.html", bodyMs: 200 },
      { patch: nodePatchDeps, style: nodeStyleDeps(workspace) },
      hub,
    );

    try {
      const route = {
        method: "GET",
        segments: ["api", "doc", ":docId", "model"],
        auth: "cookie",
        kind: "model",
      } as const;
      const reply = await runtime.dispatch(route, {}, requestLike({}));

      expect(reply.status).toBe(200);
      expect(reply.body).toContain("hr-a");
    } finally {
      runtime.close();
      hub.close();
    }
  });
});

const firstPublishEvents = async (workspace: string): Promise<readonly SseEvent[]> => {
  const { ring, hub } = ringOf();
  let fire: ((event: string, name: string | undefined) => void) | undefined;
  // 第一次 readFile 失败：noteWrite 的 modelOfPath 建不出模型 → state.load 保持 undefined。
  let reads = 0;
  const patch = {
    ...nodePatchDeps,
    fs: {
      ...nodePatchDeps.fs,
      readFile: async (path: string) => {
        reads += 1;
        if (reads === 1) throw new Error("EIO (injected: keep state.load undefined)");
        return await nodePatchDeps.fs.readFile(path);
      },
    },
  };
  const runtime = createRuntime(
    { workspace, docId: "doc.html", bodyMs: 200 },
    {
      patch,
      style: nodeStyleDeps(workspace),
      watch: (_dir, onEvent) => {
        fire = onEvent;
        return watcherLike();
      },
    },
    hub,
  );
  try {
    return await publishFirstChange(runtime, workspace, ring, (name) => fire?.("change", name));
  } finally {
    runtime.close();
    hub.close();
  }
};

const publishFirstChange = async (
  runtime: Runtime,
  workspace: string,
  ring: ReturnType<typeof createEventRing>,
  emit: (name: string) => void,
): Promise<readonly SseEvent[]> => {
  const target = await resolveTarget({ workspace, file: "doc.html" }, nodePatchDeps.fs);
  runtime.noteWrite({
    reply: { status: 200, headers: {}, body: "" },
    target,
    revision: "0".repeat(16),
    changed: true,
    changedNodes: [],
  });
  emit("doc.html");
  await waitFor(() => ring.since(0).events.filter((e) => e.type === "doc.changed").length >= 2);
  return ring.since(0).events;
};

describe("runtime · 第一次发布（previous 还没有模型）", () => {
  it("should use the empty changedNodes when the first publish has no previous model", async () => {
    const workspace = tmp("hr-first-ws-");
    writeFileSync(join(workspace, "doc.html"), DOC, "utf8");

    const changed = (await firstPublishEvents(workspace)).filter(
      (event) => event.type === "doc.changed",
    );

    expect(changed.length).toBeGreaterThanOrEqual(2);
    const payload = JSON.stringify(changed[changed.length - 1]?.payload);
    expect(payload).toContain('"changedNodes":[]');
    // 真 sha 前缀 ≠ noteWrite 的假 "000…"：证明这条是 publishChanged 发的，而不是自写回声。
    expect(payload).not.toContain('"revision":"0000000000000000"');
  });
});
