// 旅程 7（桌面壳冒烟）：debug 二进制 --smoke 无界面路径跑通 启动 daemon → 打开文档 → 退出；
// 结束时断言没有孤儿 hr serve 进程残留。

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, test } from "vitest";

import { assert, assertEq, parseJson } from "../harness/check.ts";
import { docPath } from "../harness/cli.ts";
import { CLI_BIN, DESKTOP_DEBUG_BIN, sandbox, type TestHome } from "../harness/env.ts";
import { killAllTracked, pidAlive, run } from "../harness/proc.ts";

const skip = existsSync(DESKTOP_DEBUG_BIN)
  ? undefined
  : `未构建桌面 debug 二进制：${DESKTOP_DEBUG_BIN}`;

describe.skipIf(skip !== undefined)("desktop-smoke", () => {
  let home: TestHome;

  const daemonPids = (): number[] => {
    const dir = join(home.home, ".hreader");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.startsWith("daemon") && f.endsWith(".json"))
      .map((f) => {
        try {
          const j = parseJson(readFileSync(join(dir, f), "utf8"), f) as Record<string, unknown>;
          return typeof j["pid"] === "number" ? j["pid"] : -1;
        } catch {
          return -1;
        }
      })
      .filter((p) => p > 0);
  };

  const smoke = () =>
    run(
      DESKTOP_DEBUG_BIN,
      [
        "--smoke",
        "--home",
        home.home,
        "--workspace",
        home.ws,
        "--cli-path",
        CLI_BIN,
        "--open",
        "d.hr.html",
      ],
      { cwd: home.ws, timeoutMs: 90_000 },
    );

  beforeAll(async () => {
    home = sandbox("desktop");
    await writeFile(
      docPath(home.ws, "d.hr.html"),
      `<!DOCTYPE html><html><body><article><p data-hr-id="p">smoke</p></article></body></html>`,
      "utf8",
    );
  });

  afterAll(async () => {
    await killAllTracked();
    for (const pid of daemonPids()) {
      assert(!pidAlive(pid), `孤儿 hr serve 进程残留：pid=${String(pid)}`);
    }
    home.cleanup();
  });

  test("--smoke 无界面路径跑通且输出一行 JSON", async () => {
    const res = await smoke();
    assertEq(
      res.code,
      0,
      `desktop --smoke 退出码（stdout: ${res.stdout.slice(0, 300)} stderr: ${res.stderr.slice(0, 300)}）`,
    );
    const jsonLine = res.stdout
      .trim()
      .split("\n")
      .find((l) => l.trim().startsWith("{"));
    assert(jsonLine !== undefined, `--smoke stdout 没有 JSON 行：${res.stdout.slice(0, 300)}`);
  });

  test("--smoke 退出后无孤儿 hr serve 进程", async () => {
    const res = await smoke();
    assertEq(res.code, 0, "desktop --smoke 退出码");
    for (const pid of daemonPids()) {
      assert(!pidAlive(pid), `smoke 退出后 daemon 进程仍活：pid=${String(pid)}`);
    }
  });
});
