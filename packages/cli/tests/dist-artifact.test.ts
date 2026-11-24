// 这层管：交付物 `dist/cli.mjs` 的写盘路径回归——`patch` 落盘走 write-file-atomic（CJS），
// 产物里 `__filename`/`__dirname` 的 define 一丢，这个用例在真子进程里当场崩。
// 测的是 `package.json` 的 `bin` 指向的产物，不是 src；mcp-server 侧的对应探针在 stdio.test.ts。

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { expectNoAnsi, withTempDir, type CliResult } from "./harness";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST_CLI = join(PACKAGE_ROOT, "dist", "cli.mjs");

const runDist = async (args: readonly string[], cwd: string): Promise<CliResult> =>
  new Promise<CliResult>((resolve, reject) => {
    const child = spawn(process.execPath, [DIST_CLI, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code, stdout, stderr, signal });
    });
  });

const DOC = [
  '<!doctype html><html><body><article data-hr-id="hr-0">',
  '<h1 data-hr-id="hr-a">章标题</h1><p data-hr-id="hr-b">会被删掉的正文。</p>',
  "</article></body></html>",
  "",
].join("\n");

beforeAll(() => {
  execFileSync("node", ["scripts/build.mjs"], { cwd: PACKAGE_ROOT, stdio: "pipe" });
}, 120_000);

describe("dist/cli.mjs · 写盘路径", () => {
  it("should patch then undo against the built artifact", async () => {
    expect(existsSync(DIST_CLI)).toBe(true);

    await withTempDir(async (dir) => {
      const path = join(dir, "d.html");
      writeFileSync(path, DOC);

      const patch = await runDist(["patch", "d.html", "hr-b", "--action", "delete"], dir);
      expectNoAnsi(patch);
      expect(patch.code).toBe(0);
      expect(readFileSync(path, "utf8")).not.toContain("会被删掉的正文");

      const undo = await runDist(["undo", "d.html"], dir);
      expectNoAnsi(undo);
      expect(undo.code).toBe(0);
      expect(readFileSync(path, "utf8")).toBe(DOC);
    });
  });
});
