// This layer covers the Skill shell `skills/hreader/scripts/hr.mjs` (real subprocess + real exit-code passthrough); no spawn mocking.

import { spawn, type ChildProcess } from "node:child_process";
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

describe("hr.mjs · runnable outside the repo", () => {
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

describe("hr.mjs · paths and exit codes", () => {
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
      expect(missingNode.stderr).toContain('文档里没有 id 为 "hr-nope" 的节点。');

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

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const firstLineOf = (child: ChildProcess): Promise<string> =>
  new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      reject(new Error("hr.mjs serve printed no startup envelope within 10s"));
    }, 10_000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buf += chunk;
      const at = buf.indexOf("\n");
      if (at === -1) return;
      clearTimeout(timer);
      resolve(buf.slice(0, at));
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

const portFromEnvelope = (line: string, expectedPid: number | undefined): number => {
  const envelope: unknown = JSON.parse(line);
  if (!isRecord(envelope) || !isRecord(envelope["data"])) {
    throw new Error(`启动信封格式有误：${line}`);
  }
  const data = envelope["data"];
  expect(envelope["ok"]).toBe(true);
  expect(data["pid"]).toBe(expectedPid);
  const port = data["port"];
  if (typeof port !== "number") throw new Error(`port 不是数字：${line}`);
  return port;
};

describe("hr.mjs · serve PID consistency (the desktop shell probes /healthz by the child PID)", () => {
  it("should keep the same pid in the serve envelope and /healthz as the spawned wrapper", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      const home = join(dir, "home");
      mkdirSync(home);
      writeFileSync(join(dir, "a.html"), DOC);
      const child = spawn(
        process.execPath,
        [SHELL, "serve", "a.html", "--port", "0", "--home", home, "--json"],
        { cwd: dir, stdio: ["ignore", "pipe", "pipe"] },
      );
      try {
        const port = portFromEnvelope(await firstLineOf(child), child.pid);
        const health: unknown = await (
          await fetch(`http://127.0.0.1:${String(port)}/healthz`)
        ).json();
        expect(health).toMatchObject({ ok: true, pid: child.pid });
      } finally {
        if (child.exitCode === null) {
          child.kill("SIGTERM");
          await new Promise<void>((resolve) => {
            child.once("close", () => {
              resolve();
            });
          });
        }
      }
    });
  });
});
