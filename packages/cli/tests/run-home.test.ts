// 这层管：`run(["serve", …])` 不带 `--home` 时的落点。
// 为什么单独成文件：这条用例要真起一次服务，和 `run.test.ts` 的假 io 用例不同源（同 `run-paths.test.ts` 的分法）。

import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";

import { run, type CliIo } from "../src/run";

// 模块顶层先把 `HOME` 指到沙箱：`run()` 的落点是 `io.home ?? homedir()`，接线一断就会落回
// `homedir()`；不重定向的话，这条文件会先写掉真实 `~/.hreader/daemon.json` 再断言失败（真实事故）。
// 模块顶层改写 `process.env` 必须自己还原：`afterAll` 会删掉沙箱，不还原的话同 worker 里后续
// 测试文件的 `homedir()` 会指向一个已删除的目录（vitest `maxWorkers: 2`，见 vitest.config.ts:31）。
const previousHome = process.env["HOME"];
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "hr-run-home-env-")));
process.env["HOME"] = sandbox;

const dir = realpathSync(mkdtempSync(join(tmpdir(), "hr-run-home-")));
const home = realpathSync(mkdtempSync(join(tmpdir(), "hr-run-state-")));
writeFileSync(
  join(dir, "a.html"),
  '<article data-hr-id="hr-a"><h2 data-hr-id="hr-b">标题</h2><p data-hr-id="hr-c">正文</p></article>',
);
afterAll(() => {
  // 先还原 `HOME`，再删沙箱：顺序反了就会把 `HOME` 留在一个不存在的目录上。
  if (previousHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = previousHome;
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(sandbox, { recursive: true, force: true });
});

const ioWith = (homePath: string | undefined, stop: Promise<void>): CliIo => ({
  cwd: dir,
  stdout: () => undefined,
  stderr: () => undefined,
  readStdin: () => Promise.resolve(new Uint8Array()),
  debug: false,
  launchParentPid: process.ppid,
  stop,
  ...(homePath === undefined ? {} : { home: homePath }),
});

const waitForOf = async (check: () => boolean): Promise<boolean> => {
  for (let index = 0; index < 500; index += 1) {
    if (check()) return true;
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  return false;
};

// 守卫：`homedir()` 必须已被重定向到沙箱。否则接线一断，回落路径会写真实 `~/.hreader`，
// 表现为"生产数据被动过"而不是"这条用例红"。
it("should have redirected HOME to a temp dir, so a broken wiring cannot touch the real one", () => {
  expect(homedir().startsWith(sandbox)).toBe(true);
});

it("should write daemon.json under the injected home when --home is absent", async () => {
  let release: () => void = () => undefined;
  const stop = new Promise<void>((resolve) => {
    release = resolve;
  });

  const running = run(["serve", "a.html", "--port", "0", "--json"], ioWith(home, stop));
  const daemon = join(home, ".hreader", "daemon.json");
  const appeared = await waitForOf(() => existsSync(daemon));
  release();

  expect(await running).toBe(0);
  expect(appeared).toBe(true);
  expect(await waitForOf(() => !existsSync(daemon))).toBe(true);
}, 20_000);
