// 这层管：Skill 壳 `skills/hreader/scripts/hr.mjs`（真子进程 + 真退出码透传）；不 mock spawn。

import { spawn } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { withTempDir } from "./harness";

const SHELL = fileURLToPath(new URL("../../../skills/hreader/scripts/hr.mjs", import.meta.url));

interface ShellResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const runShell = async (args: readonly string[], cwd: string): Promise<ShellResult> =>
  new Promise<ShellResult>((resolve, reject) => {
    const child = spawn(process.execPath, [SHELL, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`hr.mjs 超过 10s：${args.join(" ")}`));
    }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on("error", reject);
  });

const DOC =
  '<article data-hr-id="hr-a"><h2 data-hr-id="hr-b">标题</h2><p data-hr-id="hr-c">正文</p></article>';

const expectClean = (result: ShellResult): void => {
  expect(result.stdout).not.toContain("\u001B");
  expect(result.stderr).not.toContain("\u001B");
};

describe("hr.mjs · 在仓库外可运行", () => {
  it("should outline from a temp cwd (paths resolved by the caller's cwd)", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      const path = join(dir, "a.html");
      writeFileSync(path, DOC);
      const result = await runShell(["outline", "a.html"], dir);

      expectClean(result);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("- hr-b  标题  (2w)\n");
      expect(result.stderr).toBe("");
    });
  });
});

describe("hr.mjs · 路径与退出码", () => {
  it("should work when the path contains spaces and Chinese characters", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      const sub = join(dir, "空 格 目录");
      mkdirSync(sub);
      writeFileSync(join(sub, "文章 一.html"), DOC);
      const result = await runShell(["outline", "空 格 目录/文章 一.html", "--json"], dir);

      expectClean(result);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toMatchObject({ ok: true });
    });
  });

  it("should pass exit codes through (1 / 2 / 3)", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      writeFileSync(join(dir, "a.html"), DOC);

      const missingNode = await runShell(["patch", "a.html", "hr-nope", "--action", "delete"], dir);
      expect(missingNode.code).toBe(1);
      expect(missingNode.stderr).toContain("找不到 data-hr-id");

      const noArgs = await runShell([], dir);
      expect(noArgs.code).toBe(2);
      expect(noArgs.stdout).toContain("用法：node skills/hreader/scripts/hr.mjs");

      const noFile = await runShell(["outline", "missing.html"], dir);
      expect(noFile.code).toBe(3);
      expect(noFile.stderr).toContain("读取时路径不存在");
    });
  });
});

describe("hr.mjs · --help", () => {
  it("should forward --help with exit 0", async () => {
    const result = await runShell(["--help"], process.cwd());
    expectClean(result);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("hr style <file>");
  });
});
