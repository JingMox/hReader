// 这层管：`hr png` 真子进程的退出码与进程卫生（假 Chrome 脚本，不碰真 Chrome）；
// 图像语义在 `png-command.test.ts`，报文序列在 `chrome-cdp.test.ts`。
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

describe("hr png · 取值越界 (exit 1)", () => {
  it.each([
    ["--width", "4097", "--width 必须是 256..4096 的整数"],
    ["--width", "100", "--width 必须是 256..4096 的整数"],
    ["--scale", "4", "--scale 必须是 1..3 的整数"],
    ["--max-height", "999", "--max-height 必须是 1000..50000 的整数"],
  ])("%s %s 在起 Chrome 前就被拒", async (flag, value, expected) => {
    await docDirOf(async (dir) => {
      const result = await runCli(["png", "a.html", "--out", "a.png", "--json", flag, value], {
        cwd: dir,
        env: { HREADER_CHROME: join(dir, "no-chrome") },
      });
      expect(result.code).toBe(1);
      // `--json` 只有一条通道：越界说明在信封的 message 里，stderr 留空。
      expect(fieldOf(parseJsonLine(result.stdout), "message")).toContain(expected);
      expect(result.stderr).toBe("");
      expect(existsSync(join(dir, "a.png"))).toBe(false);
    });
  });
});

describe("hr png · chrome 缺失", () => {
  it("--json 时 stdout 给 chrome_missing 包络、exit 3、零残留", async () => {
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

describe("hr png · 显式 max-height 面积预检", () => {
  it("--scale 3 --max-height 50000 → exit 1，且根本不 spawn Chrome（pidfile 不出现）", async () => {
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

describe("hr png · 进程卫生", () => {
  it("超时路径：exit 3、进程组无存活、TMPDIR 无残留、盘上零残留", async () => {
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

  it("Chrome 崩溃路径：exit 3、盘上零残留", async () => {
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
