// 这层管：从真实 CLI 入口（args/run）打到的分支。

import { createServer } from "node:http";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { createEventRing } from "../../src/server/event-ring";
import { run } from "../../../cli/src/run";
import { parseArgs } from "../../../cli/src/args";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const tmp = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};

describe("cli/args · --allow-host 列表", () => {
  // `tokens.ts` 的 VALUE_FLAGS 已补 `--allow-host`，正例转正。
  it("should accept --allow-host from the real CLI entry", () => {
    const parsed = parseArgs(
      ["serve", "doc.html", "--port", "6100", "--allow-host", "a.example"],
      "/ws",
    );

    expect(parsed).toMatchObject({
      ok: true,
      intent: { kind: "serve", allowHosts: ["a.example"] },
    });
  });

  it("should treat a blank --allow-host as no override", () => {
    const parsed = parseArgs(["serve", "doc.html", "--port", "6100", "--allow-host", " , "], "/ws");

    expect(parsed).toMatchObject({ ok: true, intent: { kind: "serve", allowHosts: undefined } });
  });
});

describe("cli/run · 缺省 stop 的 serve 臂", () => {
  it("should use the never stub and fail fast when the port is taken", async () => {
    const port = await (async () => {
      const srv = createServer();
      await new Promise<void>((resolve) => {
        srv.listen(0, "127.0.0.1", resolve);
      });
      const address = srv.address();
      await new Promise<void>((resolve) => {
        srv.close(() => {
          resolve();
        });
      });
      return typeof address === "object" && address !== null ? address.port : 0;
    })();
    const out: string[] = [];
    const code = await run(["serve", join(tmp("hr-run-ws-"), "doc.html"), "--port", String(port)], {
      cwd: process.cwd(),
      stdout: (text) => {
        out.push(text);
      },
      stderr: () => {
        // 端口占用只写 stderr，这里不关心内容。
      },
      readStdin: () => Promise.resolve(Buffer.alloc(0)),
      debug: false,
      launchParentPid: process.ppid,
      // 沙箱 home：这条跑真 `serve`，默认落 `homedir()` 会碰真实 `~/.hreader`。
      home: tmp("hr-run-home-"),
    });

    expect(code).toBe(3);
    expect(out.join("")).toBe("");
  }, 10_000);
});

describe("event-ring · payload 没有 type 字符串", () => {
  it("should fall back to an empty type instead of throwing", () => {
    const ring = createEventRing(2);
    ring.push("x", { type: 42 });
    const backfill = ring.since(0);

    expect(backfill.hit).toBe(true);
    expect(backfill.events[0]?.payload).toEqual({ type: 42 });
  });
});
