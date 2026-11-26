// This layer covers `hr png` real-subprocess exit codes and process hygiene (fake Chrome script, no real Chrome);
// image semantics live in `png-command.test.ts`, message sequences in `chrome-cdp.test.ts`.
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
import { fieldOf, parseJsonLine, runCli, withTempDir } from "./harness";

const FAKE_CHROME = fileURLToPath(new URL("../fixtures/fake-chrome.mjs", import.meta.url));

const pidAliveOf = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const docDirOf = async (run: (dir: string) => Promise<void>): Promise<void> =>
  withTempDir(async (raw) => {
    const dir = realpathSync(raw);
    writeFileSync(join(dir, "a.html"), DOC);
    await run(dir);
  }, 20_000);

describe("hr png · out-of-range values (exit 1)", () => {
  it.each([
    ["--width", "4097", "--width 必须是 256..4096 的整数"],
    ["--width", "100", "--width 必须是 256..4096 的整数"],
    ["--scale", "4", "--scale 必须是 1..3 的整数"],
    ["--max-height", "999", "--max-height 必须是 1000..50000 的整数"],
  ])("should reject %s %s before Chrome ever starts", async (flag, value, expected) => {
    await docDirOf(async (dir) => {
      const result = await runCli(["png", "a.html", "--out", "a.png", "--json", flag, value], {
        cwd: dir,
        env: { HREADER_CHROME: join(dir, "no-chrome") },
      });
      expect(result.code).toBe(1);
      // `--json` has only one channel: the out-of-range explanation rides the envelope's message, stderr stays empty.
      expect(fieldOf(parseJsonLine(result.stdout), "message")).toContain(expected);
      expect(result.stderr).toBe("");
      expect(existsSync(join(dir, "a.png"))).toBe(false);
    });
  });
});

describe("hr png · chrome missing", () => {
  it("should give the chrome_missing envelope on stdout, exit 3 and zero leftovers under --json", async () => {
    await docDirOf(async (dir) => {
      const result = await runCli(["png", "a.html", "--out", "a.png", "--json"], {
        cwd: dir,
        env: { HREADER_CHROME: join(dir, "no-chrome") },
      });
      expect(result.code).toBe(3);
      const envelope: unknown = JSON.parse(result.stdout);
      expect(Reflect.get(Object(envelope), "code")).toBe("chrome_missing");
      expect(readdirSync(dir).sort()).toEqual(["a.html"]);
    });
  });
});

interface Hygiene {
  readonly dir: string;
  readonly tmpRoot: string;
  readonly pidPath: string;
}

const withHygieneOf = async (run: (setup: Hygiene) => Promise<void>): Promise<void> => {
  await docDirOf(async (dir) => {
    const tmpRoot = join(dir, "chrome-tmp");
    mkdirSync(tmpRoot);
    await run({ dir, tmpRoot, pidPath: join(dir, "chrome.pid") });
  });
};

const runHygieneOf = (setup: Hygiene, args: readonly string[], extraEnv: Record<string, string>) =>
  runCli(args, {
    cwd: setup.dir,
    env: {
      HREADER_CHROME: FAKE_CHROME,
      TMPDIR: setup.tmpRoot,
      FAKE_CHROME_PID_FILE: setup.pidPath,
      ...extraEnv,
    },
  });

const assertCleanOf = (setup: Hygiene): void => {
  expect(existsSync(join(setup.dir, "a.png"))).toBe(false);
  expect(readdirSync(setup.tmpRoot)).toEqual([]);
  if (existsSync(setup.pidPath)) {
    expect(pidAliveOf(Number(readFileSync(setup.pidPath, "utf8")))).toBe(false);
  }
};

describe("hr png · explicit max-height area pre-check", () => {
  it("should exit 1 for --scale 3 --max-height 50000 and never spawn Chrome (no pidfile appears)", async () => {
    await withHygieneOf(async (setup) => {
      const result = await runHygieneOf(
        setup,
        ["png", "a.html", "--out", "a.png", "--scale", "3", "--max-height", "50000"],
        {},
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("超过总像素");
      expect(existsSync(setup.pidPath)).toBe(false);
      expect(readdirSync(setup.tmpRoot)).toEqual([]);
      expect(existsSync(join(setup.dir, "a.png"))).toBe(false);
    });
  }, 20_000);
});

describe("hr png · process hygiene", () => {
  it("should exit 3 on the timeout path with no process group alive, nothing in TMPDIR, zero on-disk leftovers", async () => {
    await withHygieneOf(async (setup) => {
      const result = await runHygieneOf(
        setup,
        ["png", "a.html", "--out", "a.png", "--timeout", "1"],
        {
          FAKE_CHROME_SLEEP: "1",
        },
      );
      expect(result.code).toBe(3);
      expect(result.stderr).toContain("渲染超时");
      assertCleanOf(setup);
    });
  }, 20_000);

  it("should exit 3 on the Chrome-crash path with zero on-disk leftovers", async () => {
    await withHygieneOf(async (setup) => {
      const result = await runHygieneOf(setup, ["png", "a.html", "--out", "a.png"], {
        FAKE_CHROME_EXIT: "1",
      });
      expect(result.code).toBe(3);
      expect(result.stderr).toContain("Chrome 提前退出");
      assertCleanOf(setup);
    });
  }, 20_000);
});
