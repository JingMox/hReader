// Journey 6 (the CLI as a pipe): --json emits a single line a JSON parser can
// consume, | head -1 doesn't die of EPIPE, non-TTY output has no ANSI, and
// success/failure exit codes under set -e follow the code table.

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

test("should emit a single parseable --json line when piped into a JSON processor", async () => {
  const res = await runSh(
    `"${process.execPath}" "${CLI_BIN}" check d.hr.html --workspace "${home.ws}" --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);if(j.ok!==true)process.exit(2)})"`,
    { cwd: home.ws },
  );
  assertEq(res.code, 0, `JSON pipe exit code (stderr: ${res.stderr.slice(0, 200)})`);
});

test("should survive | head -1 without EPIPE hanging the CLI or exiting non-zero", async () => {
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
    `head -1 pipe exit code (stdout: ${res.stdout.slice(0, 200)} stderr: ${res.stderr.slice(0, 200)})`,
  );
});

test("should emit no ANSI escapes on non-TTY output", async () => {
  const res = await hr(["check", "d.hr.html", "--workspace", home.ws], { cwd: home.ws });
  assertEq(res.code, 0, "non-TTY check exit code");
  assert(!res.stdout.includes("["), "non-TTY output contains ANSI escapes");
});

test("should run to completion on success and stop on the failing command's code under set -e", async () => {
  const ok = await runSh(
    `set -e; "${process.execPath}" "${CLI_BIN}" check d.hr.html --workspace "${home.ws}" --json > /dev/null; echo reached`,
    { cwd: home.ws },
  );
  assertEq(ok.code, 0, "exit code of the succeeding command under set -e");
  assert(
    ok.stdout.includes("reached"),
    "the script did not run to completion after the succeeding command under set -e",
  );
  const bad = await runSh(
    `set -e; "${process.execPath}" "${CLI_BIN}" undo missing.hr.html --workspace "${home.ws}" --json > /dev/null; echo should-not-reach`,
    { cwd: home.ws },
  );
  assert(bad.code !== 0, "the failing command unexpectedly returned 0 under set -e");
  assert(!bad.stdout.includes("should-not-reach"), "set -e did not stop at the failing command");
});
