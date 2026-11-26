// 旅程 6（CLI 作管道）：--json 单行可进 JSON 解析器、| head -1 不死于 EPIPE、非 TTY 无 ANSI、
// set -e 下成功/失败退出码符合码表。

import { writeFile } from "node:fs/promises";

import { afterAll, beforeAll, test } from "vitest";

import { assert, assertEq } from "../harness/check.ts";
import { docPath, hr } from "../harness/cli.ts";
import { CLI_BIN, sandbox, type TestHome } from "../harness/env.ts";
import { killAllTracked, run, runSh } from "../harness/proc.ts";

let home: TestHome;

beforeAll(async () => {
  home = sandbox("pipes");
  await writeFile(
    docPath(home.ws, "d.hr.html"),
    `<!DOCTYPE html><html><body><article><p data-hr-id="p">x</p></article></body></html>`,
    "utf8",
  );
});

afterAll(async () => {
  await killAllTracked();
  home.cleanup();
});

test("--json 输出单行可解析（管道到 JSON 处理器语义）", async () => {
  const res = await runSh(
    `"${process.execPath}" "${CLI_BIN}" check d.hr.html --workspace "${home.ws}" --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);if(j.ok!==true)process.exit(2)})"`,
    { cwd: home.ws },
  );
  assertEq(res.code, 0, `JSON 管道退出码（stderr: ${res.stderr.slice(0, 200)}）`);
});

test("| head -1 不死（EPIPE 不让 CLI 挂起或非零退出）", async () => {
  const res = await run(
    "/bin/bash",
    [
      "-c",
      `"${process.execPath}" "${CLI_BIN}" check d.hr.html --workspace "${home.ws}" --json | head -1; test \${PIPESTATUS[0]} -eq 0`,
    ],
    { cwd: home.ws, timeoutMs: 15_000 },
  );
  assertEq(
    res.code,
    0,
    `head -1 管道退出码（stdout: ${res.stdout.slice(0, 200)} stderr: ${res.stderr.slice(0, 200)}）`,
  );
});

test("非 TTY 输出无 ANSI 转义", async () => {
  const res = await hr(["check", "d.hr.html", "--workspace", home.ws], { cwd: home.ws });
  assertEq(res.code, 0, "非 TTY check 退出码");
  assert(!res.stdout.includes("["), "非 TTY 输出含 ANSI 转义序列");
});

test("set -e 脚本：成功命令走完，失败命令按码停", async () => {
  const ok = await runSh(
    `set -e; "${process.execPath}" "${CLI_BIN}" check d.hr.html --workspace "${home.ws}" --json > /dev/null; echo reached`,
    { cwd: home.ws },
  );
  assertEq(ok.code, 0, "set -e 下成功命令退出码");
  assert(ok.stdout.includes("reached"), "set -e 下成功命令后脚本没走完");
  const bad = await runSh(
    `set -e; "${process.execPath}" "${CLI_BIN}" undo missing.hr.html --workspace "${home.ws}" --json > /dev/null; echo should-not-reach`,
    { cwd: home.ws },
  );
  assert(bad.code !== 0, "set -e 下失败命令竟返回 0");
  assert(!bad.stdout.includes("should-not-reach"), "set -e 没在失败命令处停");
});
