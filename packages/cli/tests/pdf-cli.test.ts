// This layer covers `hr pdf` real-subprocess exit codes and process hygiene (fake Chrome script, no real Chrome).
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DOC } from "./cli-support";
import { runCli, withTempDir, type CliResult } from "./harness";

const FAKE_CHROME = fileURLToPath(new URL("../fixtures/fake-chrome.mjs", import.meta.url));

const pidAliveOf = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("hr pdf · chrome missing", () => {
  it("should give the chrome_missing envelope on stdout and exit 3 under --json", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      writeFileSync(join(dir, "a.html"), DOC);
      const result = await runCli(["pdf", "a.html", "--out", "a.pdf", "--json"], {
        cwd: dir,
        env: { HREADER_CHROME: join(dir, "no-chrome") },
      });
      expect(result.code).toBe(3);
      const envelope: unknown = JSON.parse(result.stdout);
      expect(Reflect.get(Object(envelope), "ok")).toBe(false);
      expect(Reflect.get(Object(envelope), "code")).toBe("chrome_missing");
      // The one-shot error only goes to stdout; the actual state of HREADER_CHROME comes out with the message.
      expect(Reflect.get(Object(envelope), "message")).toContain("HREADER_CHROME=");
      expect(result.stderr).toBe("");
      expect(existsSync(join(dir, "a.pdf"))).toBe(false);
    });
  });

  it("should give a single error line and exit 3 in human mode", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      writeFileSync(join(dir, "a.html"), DOC);
      const result = await runCli(["pdf", "a.html", "--out", "a.pdf"], {
        cwd: dir,
        env: { HREADER_CHROME: join(dir, "no-chrome") },
      });
      expect(result.code).toBe(3);
      expect(result.stdout).toBe("");
      expect(result.stderr.trimEnd().split("\n").length).toBe(1);
      expect(result.stderr).toContain("找不到 Chrome");
    });
  });
});

interface HygieneSetup {
  readonly dir: string;
  readonly tmpRoot: string;
  readonly pidPath: string;
}

const hygieneOf = (dir: string): HygieneSetup => {
  const tmpRoot = join(dir, "chrome-tmp");
  mkdirSync(tmpRoot);
  return { dir, tmpRoot, pidPath: join(dir, "chrome.pid") };
};

const assertCleanOf = (setup: HygieneSetup): void => {
  expect(readdirSync(setup.tmpRoot)).toEqual([]);
  if (existsSync(setup.pidPath)) {
    const pid = Number(readFileSync(setup.pidPath, "utf8"));
    expect(pidAliveOf(pid)).toBe(false);
  }
};

const docDirOf = async (run: (dir: string) => Promise<void>): Promise<void> =>
  withTempDir(async (raw) => {
    const dir = realpathSync(raw);
    writeFileSync(join(dir, "a.html"), DOC);
    await run(dir);
  }, 20_000);

const runHygieneOf = (
  setup: HygieneSetup,
  args: readonly string[],
  extraEnv: Record<string, string>,
): Promise<CliResult> =>
  runCli(args, {
    cwd: setup.dir,
    env: { HREADER_CHROME: FAKE_CHROME, TMPDIR: setup.tmpRoot, ...extraEnv },
  });

describe("hr pdf · process hygiene", () => {
  it("should exit 3 on the timeout path with no process group alive and no hr-chrome-* in TMPDIR", async () => {
    await docDirOf(async (dir) => {
      const setup = hygieneOf(dir);
      const args = ["pdf", "a.html", "--out", "a.pdf", "--timeout", "1"];
      const result = await runHygieneOf(setup, args, {
        FAKE_CHROME_SLEEP: "1",
        FAKE_CHROME_PID_FILE: setup.pidPath,
      });
      expect(result.code).toBe(3);
      expect(result.stderr).toContain("渲染超时");
      expect(existsSync(join(dir, "a.pdf"))).toBe(false);
      assertCleanOf(setup);
    });
  });

  it("should exit 3 on the Chrome-crash path with no process group alive and no hr-chrome-* in TMPDIR", async () => {
    await docDirOf(async (dir) => {
      const setup = hygieneOf(dir);
      const result = await runHygieneOf(setup, ["pdf", "a.html", "--out", "a.pdf"], {
        FAKE_CHROME_EXIT: "1",
        FAKE_CHROME_PID_FILE: setup.pidPath,
      });
      expect(result.code).toBe(3);
      expect(result.stderr).toContain("Chrome 提前退出（code 2）：fake chrome: cannot start");
      expect(result.stderr).not.toContain("second line");
      assertCleanOf(setup);
    });
  });
});
