// 这层管：`serve` 起不来时**用户看到什么**（B-19/B-20）。
//
// 三种"起不来"必须能分开，因为下一步动作完全不同：
//   · 端口被别人占了   → `port_in_use`（换端口）
//   · 本 home 已有 daemon → `daemon_already_running`（停掉旧的 / 删 daemon.json）
//   · daemon.json 是上次 kill -9 留下的尸体 → **不该拦人**，直接接管

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checked } from "./cli-support";
import { fieldOf, parseJsonLine, runCli, textOf, withTempDir } from "./harness";
import { homeOf, startServe } from "./serve-harness";

const DOC = '<article data-hr-id="hr-a"><h1 data-hr-id="hr-b">章</h1></article>';

const seed = (dir: string): void => {
  writeFileSync(join(dir, "doc.html"), DOC);
};

/** 起第二个 serve 并返回"退出码 + 拒绝信封"（两条"起不来"共用同一套解读）。 */
const secondServe = async (
  dir: string,
  port: string,
  home: string,
): Promise<{ code: number | null; envelope: unknown }> => {
  const result = checked(
    await runCli(["serve", "doc.html", "--port", port, "--home", home, "--json"], { cwd: dir }),
  );
  const envelope = parseJsonLine(result.stdout);
  expect(fieldOf(envelope, "ok")).toBe(false);
  return { code: result.code, envelope };
};

describe("hr serve · 端口被别人占了", () => {
  it("should say port_in_use when another server holds the port", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const running = await startServe("doc.html", { json: true, home: homeOf(dir), cwd: dir });
      try {
        // json 模式也得是程序自己印的那串：`?token=` 丢了这里就红。
        expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+$/u);
        // 另一个 home + 同一个端口：用户以为"换个 workspace 就能再起一份"，其实不行。
        const otherHome = join(dir, "home-other");
        mkdirSync(otherHome, { recursive: true });
        const { code, envelope } = await secondServe(dir, String(running.port), otherHome);

        expect(code).toBe(2);
        expect(fieldOf(envelope, "code")).toBe("port_in_use");
        // 消息里要带真端口号，用户才能确认"是我以为的那个端口"。
        expect(textOf(fieldOf(envelope, "message"))).toContain(String(running.port));
        expect(textOf(fieldOf(envelope, "message"))).toContain("--port");
      } finally {
        await running.stop();
      }
    }, 30_000);
  });
});

describe("hr serve · 这个 home 已经有一份在跑", () => {
  it("should say daemon_already_running (with the port) when this home already serves", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const home = homeOf(dir);
      const running = await startServe("doc.html", { json: true, home, cwd: dir });
      try {
        expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+$/u);
        const { code, envelope } = await secondServe(dir, "0", home);

        expect(fieldOf(envelope, "code")).toBe("daemon_already_running");
        // 已有 daemon 属于"状态冲突"（1），不是"参数写错"（2）——两者要能靠退出码区分。
        expect(code).toBe(1);
        expect(textOf(fieldOf(envelope, "message"))).toContain("daemon.json");
        expect(textOf(fieldOf(envelope, "message"))).toContain(String(running.port));
      } finally {
        await running.stop();
      }
    }, 30_000);
  });
});

describe("hr serve · 上次 kill -9 留下的 daemon.json", () => {
  it("should take over a stale daemon.json left behind by kill -9", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const home = homeOf(dir);
      // 上次 daemon 被 kill -9：daemon.json 还在，pid 早就不存在了。
      mkdirSync(join(home, ".hreader"), { recursive: true });
      writeFileSync(
        join(home, ".hreader", "daemon.json"),
        JSON.stringify({ port: 1, pid: 2_000_000_000, token: "stale", workspace: dir }),
      );

      const running = await startServe("doc.html", { json: true, home, cwd: dir });
      try {
        expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+$/u);
        // 接管成功：新 daemon.json 换成自己（pid/token 都变了）。
        const written: unknown = JSON.parse(
          readFileSync(join(home, ".hreader", "daemon.json"), "utf8"),
        );

        expect(fieldOf(written, "port")).toBe(running.port);
        expect(fieldOf(written, "token")).toBe(running.token);
        expect(fieldOf(written, "token")).not.toBe("stale");
      } finally {
        await running.stop();
      }
    }, 30_000);
  });
});
