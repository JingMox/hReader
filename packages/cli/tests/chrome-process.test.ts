// This layer covers the real `chromeDepsOf` (real spawn / real process-group kill); not one real Chrome starts.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { chromeProcessOf, type ChromeProcess } from "../src/chrome/process";
import { chromeDepsOf } from "../src/chrome/session";

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
  throw new Error("timed out waiting for condition");
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

describe("chromeDepsOf · filesystem and environment", () => {
  it("should pass env/exists/tempDir/remove straight through to the real filesystem", () => {
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

describe("chromeDepsOf · spawn and stderr", () => {
  it("should receive stderr and an exit code from the spawned process", async () => {
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

  it("should deliver the whole stderr stream by the time onClose fires", async () => {
    const deps = chromeDepsOf({});
    const child = deps.spawn(process.execPath, ["-e", "process.stderr.write('tail-ok')"], {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr: string[] = [];
    child.onStderr((text) => {
      stderr.push(text);
    });
    const code = await new Promise<number | null>((resolve) => {
      child.onClose(resolve);
    });
    // 'close' is the drained-stream point: everything the process wrote has arrived by now.
    expect(code).toBe(0);
    expect(stderr.join("")).toBe("tail-ok");
    child.killGroup("SIGKILL");
  });

  it("should do nothing in onStderr when stdio gives no stderr pipe", async () => {
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
  it("should report ENOENT via onError when the binary is missing and make killGroup a no-op when pid is empty", async () => {
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

  it("should kill a real process group with killGroup and not throw on an exited group", async () => {
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

describe("chromeDepsOf · killGroup and grandchildren", () => {
  // The discriminator: `process.kill(pid)` also kills the main process, so "main is dead" cannot prove the
  // group was killed; only grandchildren in the same group stopping proves `-pid` was not written as `pid`.
  it("should stop grandchildren too because killGroup takes the whole process group", async () => {
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
      // The marker file is created by the grandchild's appendFileSync: file exists = at least one byte written, ticking>0 is settled.
      const ticking = readFileSync(marker, "utf8").length;
      const exited = waitForExitOf(child);
      child.killGroup("SIGTERM");
      await exited;
      // The main process has exited: the remaining byte count is the one vote on whether the grandchild is still alive.
      const frozen = readFileSync(marker, "utf8").length;
      expect(ticking).toBeGreaterThan(0);
      // Negative window: proving "the grandchild writes no more" needs a silent period. 40ms per tick, 300ms ≈ 7
      // cycles of headroom; the file has no other observable "writer is dead" signal — this window is the stillness itself.
      await sleepOf(300);
      expect(readFileSync(marker, "utf8").length).toBe(frozen);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
