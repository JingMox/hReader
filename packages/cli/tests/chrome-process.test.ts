// 这层管：`chromeDepsOf` 的真实现（真 spawn / 真 fetch / 真进程组 kill）；一个真 Chrome 都不起。
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { chromeDepsOf, chromeProcessOf, type ChromeProcess } from "../src/chrome/session";

const FAKE_CHROME = fileURLToPath(new URL("../fixtures/fake-chrome.mjs", import.meta.url));

const sleepOf = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const waitForOf = async (check: () => boolean): Promise<void> => {
  for (let index = 0; index < 200; index += 1) {
    if (check()) return;
    await sleepOf(10);
  }
  throw new Error("等待条件超时");
};

const waitForErrorOf = (child: ChromeProcess): Promise<Error> =>
  new Promise((resolve) => {
    child.onError(resolve);
  });

const waitForExitOf = (child: ChromeProcess): Promise<void> =>
  new Promise((resolve) => {
    child.onExit(() => {
      resolve();
    });
  });

describe("chromeDepsOf · 文件系统与环境", () => {
  it("env/exists/tempDir/remove 都直通真实文件系统", () => {
    const deps = chromeDepsOf({ HREADER_CHROME: "/x" });
    expect(deps.env["HREADER_CHROME"]).toBe("/x");
    expect(deps.killGraceMs).toBe(2000);
    expect(deps.exists("/nonexistent/hr-chrome-probe")).toBe(false);
    const chromeDir = deps.tempDir();
    expect(chromeDir).toContain("hr-chrome-");
    expect(deps.exists(chromeDir)).toBe(true);
    deps.remove(chromeDir);
    expect(deps.exists(chromeDir)).toBe(false);
  });
});

describe("chromeDepsOf · spawn 与 stderr", () => {
  it("spawn 出的进程能收到 stderr 与退出码", async () => {
    const deps = chromeDepsOf({});
    const child = deps.spawn(process.execPath, ["-e", "process.stderr.write('boot-ok')"], {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr: string[] = [];
    child.onStderr((text) => {
      stderr.push(text);
    });
    await waitForExitOf(child);
    expect(stderr.join("")).toBe("boot-ok");
    expect(child.pid).toBeDefined();
    child.killGroup("SIGKILL");
  });

  it("stdio 不给 stderr 管道时 onStderr 什么都不做", async () => {
    const child = chromeProcessOf(
      spawn(process.execPath, ["-e", ""], { stdio: ["ignore", "ignore", "ignore"] }),
    );
    expect(() => {
      child.onStderr(() => undefined);
    }).not.toThrow();
    await waitForExitOf(child);
  });
});

describe("chromeDepsOf · killGroup", () => {
  it("二进制不存在时 onError 报 ENOENT，pid 为空时 killGroup 是空操作", async () => {
    const deps = chromeDepsOf({});
    const child = deps.spawn("/nonexistent/hr-chrome", [], {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const error = await waitForErrorOf(child);
    expect(error.message).toContain("ENOENT");
    expect(child.pid).toBeUndefined();
    expect(() => {
      child.killGroup("SIGTERM");
    }).not.toThrow();
  });

  it("killGroup 杀得到真进程组，对已退出的组不抛", async () => {
    const deps = chromeDepsOf({});
    const child = deps.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    await sleepOf(100);
    const exited = waitForExitOf(child);
    child.killGroup("SIGTERM");
    await exited;
    expect(() => {
      child.killGroup("SIGKILL");
    }).not.toThrow();
  });
});

describe("chromeDepsOf · killGroup 与孙进程", () => {
  // M04 判别点：`process.kill(pid)` 也能杀掉主进程，所以“主进程死了”不能证明杀的是进程组；
  // 只有同组孙进程也停才说明 `-pid` 没被写成 `pid`（§15.2、§16.5）。
  it("killGroup 收的是整个进程组：孙进程跟着停", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hr-group-"));
    const marker = join(dir, "tick");
    try {
      const deps = chromeDepsOf({ HREADER_CHROME: FAKE_CHROME });
      const child = deps.spawn(process.execPath, [FAKE_CHROME], {
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
        env: {
          ...process.env,
          FAKE_CHROME_GRANDCHILD: "1",
          FAKE_CHROME_MARKER_FILE: marker,
        },
      });
      await waitForOf(() => existsSync(marker));
      await sleepOf(200);
      const ticking = readFileSync(marker, "utf8").length;
      const exited = waitForExitOf(child);
      child.killGroup("SIGTERM");
      await exited;
      // 主进程已退出：剩下的字节数就是孙进程是否还活着的那一票。
      const frozen = readFileSync(marker, "utf8").length;
      expect(ticking).toBeGreaterThan(0);
      await sleepOf(300);
      expect(readFileSync(marker, "utf8").length).toBe(frozen);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("chromeDepsOf · fetchText", () => {
  it("用全局 fetch 拿 /json/version", async () => {
    const server = createServer((request, response) => {
      response.end(`body:${request.url ?? ""}`);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const deps = chromeDepsOf({});
      expect(await deps.fetchText(`http://127.0.0.1:${String(port)}/json/version`)).toBe(
        "body:/json/version",
      );
    } finally {
      server.close();
    }
  });
});
