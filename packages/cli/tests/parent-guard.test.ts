// This layer covers the parent-death watchdog and `--exit-with-parent` wiring — the pure checks `parentGone` /
// `orphanedAtLaunch`, the sampling surface `parentWatchOf`, the switch `shouldWatchParent`, timer wiring
// `watchParent`, and the stretch where the flag runs from argv to the watchdog. The real-process case
// (kill -9 a fake parent → daemon suicide + port release) lives in `scripts/gui/parent-death.sh`.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PARENT_POLL_MS, orphanedAtLaunch, parentGone, parentWatchOf } from "../src/parent-guard";
import { serveCommand, shouldWatchParent, watchParent } from "../src/commands/serve";
import {
  pollTimerOf,
  pollTimers,
  serveDirs,
  serveInputOf,
  startWatched,
  stopHandle,
  timerStillHoldsProcess,
  waitGone,
} from "./serve-helpers";
import { run } from "../src/run";

afterEach(() => {
  vi.restoreAllMocks();
});

const watchOf = (parentPid: number, readParentPid: () => number) => ({ parentPid, readParentPid });

describe("parentGone", () => {
  it("should stay alive while the parent pid is unchanged", () => {
    expect(parentGone(watchOf(4321, () => 4321))).toBe(false);
  });

  it("should notice a ppid of 1 as a re-parent", () => {
    expect(parentGone(watchOf(4321, () => 1))).toBe(true);
  });

  it("should notice any other ppid change", () => {
    expect(parentGone(watchOf(4321, () => 999))).toBe(true);
  });
});

describe("orphanedAtLaunch", () => {
  it("should call a ppid of 1 an orphan, not a normal parent", () => {
    expect(orphanedAtLaunch(1)).toBe(true);
    expect(orphanedAtLaunch(4321)).toBe(false);
  });
});

describe("parentWatchOf", () => {
  it("should carry the injected pid and re-read the live ppid on every poll", () => {
    const watch = parentWatchOf(4321);
    expect(watch.parentPid).toBe(4321);
    expect(watch.readParentPid()).toBe(process.ppid);
  });
});

describe("shouldWatchParent", () => {
  it("should only be true for an explicit --exit-with-parent", () => {
    expect(shouldWatchParent(undefined)).toBe(false);
    expect(shouldWatchParent(false)).toBe(false);
    expect(shouldWatchParent(true)).toBe(true);
  });
});

describe("serveCommand · the parent watchdog switch", () => {
  it("should not install a poll timer without --exit-with-parent", async () => {
    const dir = serveDirs();
    const handle = stopHandle();
    const spy = vi.spyOn(globalThis, "setInterval");
    try {
      const printed = await serveCommand(serveInputOf(dir, true, handle.stopped));
      expect(pollTimers(spy)).toBe(0);
      expect(printed).toContain('"ok":true');
    } finally {
      handle.stop();
      dir.drop();
    }
  });

  it("should install the poll timer once --exit-with-parent is on", async () => {
    const dir = serveDirs();
    const handle = stopHandle();
    try {
      const { setSpy } = await startWatched(dir, handle.stopped);
      expect(pollTimers(setSpy)).toBe(1);
    } finally {
      handle.stop();
      dir.drop();
    }
  }, 20_000);
});

describe("serveCommand · stop retracts the watchdog", () => {
  it("should drop the poll timer on stop, not just close the server", async () => {
    const dir = serveDirs();
    const handle = stopHandle();
    try {
      const { clearSpy, timer } = await startWatched(dir, handle.stopped);
      // `close()` without retracting the watchdog = after `--exit-with-parent` receives SIGTERM, the 1s timer keeps it alive.
      handle.stop();
      await vi.waitFor(() => {
        expect(clearSpy.mock.calls.some((call) => call[0] === timer)).toBe(true);
      });
    } finally {
      handle.stop();
      dir.drop();
    }
  }, 20_000);
});

describe("serveCommand · parent already dead at startup", () => {
  it("should refuse to start when the parent was already gone at launch", async () => {
    const dir = serveDirs();
    const handle = stopHandle();
    try {
      await expect(
        serveCommand({
          ...serveInputOf(dir, true, handle.stopped),
          exitWithParent: true,
          launchParentPid: 1,
        }),
      ).rejects.toThrow(/ppid=1/);
      // Exiting without creating a server: no daemon record should remain in home.
      expect(existsSync(join(dir.home, ".hreader", "daemon.json"))).toBe(false);
    } finally {
      handle.stop();
      dir.drop();
    }
  });

  it("should still start with a dead-looking parent when the flag is off", async () => {
    const dir = serveDirs();
    const handle = stopHandle();
    try {
      const printed = await serveCommand({
        ...serveInputOf(dir, true, handle.stopped),
        launchParentPid: 1,
      });
      expect(printed).toContain('"ok":true');
    } finally {
      handle.stop();
      dir.drop();
    }
  });
});

/** Run a stretch on a fake clock: interval callbacks don't really wait 1 second. */
const withFakeTimers = (body: () => void): void => {
  vi.useFakeTimers();
  try {
    body();
  } finally {
    vi.useRealTimers();
  }
};

describe("watchParent · not watching the parent", () => {
  it("should not schedule anything when the flag is off", () => {
    withFakeTimers(() => {
      const close = vi.fn(() => Promise.resolve());
      watchParent(undefined, { close });
      vi.advanceTimersByTime(PARENT_POLL_MS * 3);
      expect(close).not.toHaveBeenCalled();
    });
  });

  it("should keep the daemon up while the parent is alive", () => {
    withFakeTimers(() => {
      const close = vi.fn(() => Promise.resolve());
      watchParent(
        watchOf(4321, () => 4321),
        { close },
      );
      vi.advanceTimersByTime(PARENT_POLL_MS * 3);
      expect(close).not.toHaveBeenCalled();
    });
  });
});

describe("watchParent · the parent disappears", () => {
  it("should re-read the parent pid on every poll and close on the third one", () => {
    withFakeTimers(() => {
      const close = vi.fn(() => Promise.resolve());
      // The first two polls still see the old ppid, the third sees the change: a caching implementation would write "unchanged" on the second and never show the flip.
      const readParentPid = vi.fn(() => 999);
      readParentPid.mockReturnValueOnce(4321).mockReturnValueOnce(4321);
      watchParent(watchOf(4321, readParentPid), { close });

      vi.advanceTimersByTime(PARENT_POLL_MS * 2);
      expect(readParentPid).toHaveBeenCalledTimes(2);
      expect(close).not.toHaveBeenCalled();

      vi.advanceTimersByTime(PARENT_POLL_MS);
      expect(readParentPid).toHaveBeenCalledTimes(3);
      expect(close).toHaveBeenCalledTimes(1);
    });
  });

  it("should close once the parent disappears, and stop polling after that", () => {
    withFakeTimers(() => {
      const close = vi.fn(() => Promise.resolve());
      let ppid = 4321;
      watchParent(
        watchOf(4321, () => ppid),
        { close },
      );
      ppid = 1;
      vi.advanceTimersByTime(PARENT_POLL_MS);
      expect(close).toHaveBeenCalledTimes(1);
      // The timer must be cleared: otherwise the event loop never drains and the daemon lingers after the server is down.
      vi.advanceTimersByTime(PARENT_POLL_MS * 3);
      expect(close).toHaveBeenCalledTimes(1);
    });
  });
});

describe("watchParent · disposer", () => {
  it("should leave no timer behind once the caller disposes it", () => {
    withFakeTimers(() => {
      const dispose = watchParent(
        watchOf(4321, () => 4321),
        {
          close: vi.fn(() => Promise.resolve()),
        },
      );
      expect(vi.getTimerCount()).toBe(1);

      dispose();

      // A live timer = work remains in the event loop after `close()`; the process will not exit on its own.
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("should unref the poll timer so it can never be what holds the daemon alive", () => {
    // A real timer: under fake timers `unref()` is a no-op and deleting that `serve.ts` line turns nothing red.
    const setSpy = vi.spyOn(globalThis, "setInterval");
    const dispose = watchParent(
      watchOf(4321, () => 4321),
      {
        close: vi.fn(() => Promise.resolve()),
      },
    );

    expect(timerStillHoldsProcess(pollTimerOf(setSpy))).toBe(false);
    dispose();
  });

  it("should hand back a no-op when the flag is off", () => {
    withFakeTimers(() => {
      watchParent(undefined, { close: vi.fn(() => Promise.resolve()) })();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("serveCommand · --exit-with-parent does not interrupt the normal lifecycle", () => {
  it("should keep the watchdog and the daemon record across three live-parent polls", async () => {
    const dir = serveDirs();
    const { stop, stopped } = stopHandle();
    try {
      const { clearSpy, poll, timer } = await startWatched(dir, stopped);
      expect(timer).toBeDefined();
      expect(poll).toBeDefined();

      // The parent never changed: none of the three polls should stop the server, nor clear the watchdog.
      for (let index = 0; index < 3; index += 1) poll?.();

      expect(existsSync(join(dir.home, ".hreader", "daemon.json"))).toBe(true);
      expect(clearSpy.mock.calls.some((call) => call[0] === timer)).toBe(false);
      stop();
    } finally {
      dir.drop();
    }
  }, 20_000);

  it("should clean up on stop exactly like the default path", async () => {
    const dir = serveDirs();
    const { stop, stopped } = stopHandle();
    try {
      const { clearSpy, timer } = await startWatched(dir, stopped);

      stop();
      await vi.waitFor(() => {
        expect(existsSync(join(dir.home, ".hreader", "daemon.json"))).toBe(false);
      });
      expect(clearSpy.mock.calls.some((call) => call[0] === timer)).toBe(true);
    } finally {
      dir.drop();
    }
  });
});

describe("run · --exit-with-parent from argv to the watchdog", () => {
  it("should plumb the flag from argv through run() into the watchdog", async () => {
    const dir = serveDirs();
    const previous = process.env["HOME"];
    process.env["HOME"] = dir.home;
    const { stop, stopped } = stopHandle();
    const out: string[] = [];
    try {
      const code = await run(
        ["serve", join(dir.workspace, "doc.html"), "--port", "0", "--json", "--exit-with-parent"],
        {
          cwd: dir.workspace,
          stdout: (text) => out.push(text),
          stderr: () => undefined,
          readStdin: () => Promise.resolve(new Uint8Array()),
          debug: false,
          launchParentPid: process.ppid,
          stop: stopped,
        },
      );
      stop();
      await waitGone(join(dir.home, ".hreader", "daemon.json"));

      expect(code).toBe(0);
      expect(out.join("")).toContain('"port":');
      expect(existsSync(join(dir.home, ".hreader", "daemon.json"))).toBe(false);
    } finally {
      process.env["HOME"] = previous;
      dir.drop();
    }
  });
});
