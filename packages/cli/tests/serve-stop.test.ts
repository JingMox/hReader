// This layer: serve-harness stop() escalation — a child that ignores SIGTERM
// must be SIGKILLed once the grace window passes, not hung on until testTimeout.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { killPid } from "../../../tests/leak-guard/registry.ts";
import { stopOf } from "./serve-harness.ts";

// Fail-safe bound only: the assertions are on stop() having returned and on the
// delivered signal, never on elapsed time.
const STOP_BOUND_MS = 15_000;

const spawnTermIgnorer = (): ChildProcessByStdio<null, Readable, Readable> =>
  spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1e3); console.log('ARMED')"],
    { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" },
  );

/** Wait until the child's SIGTERM handler is installed (the ARMED receipt), else the TERM lands early and kills it. */
const armed = (child: ChildProcessByStdio<null, Readable, Readable>): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("child never armed its SIGTERM handler"));
    }, STOP_BOUND_MS);
    child.stdout.on("data", (chunk: string) => {
      if (!chunk.includes("ARMED")) return;
      clearTimeout(timer);
      resolve();
    });
  });

describe("serve-harness stop escalation", () => {
  it("should SIGKILL the group when the child ignores SIGTERM past the grace window", async () => {
    const child = spawnTermIgnorer();
    await armed(child);
    const group = process.platform !== "win32";
    const closed = new Promise<void>((resolve) => {
      child.once("close", () => {
        resolve();
      });
    });
    try {
      const stopped = await Promise.race([
        stopOf(child)().then(() => true),
        new Promise<false>((resolve) => {
          setTimeout(() => {
            resolve(false);
          }, STOP_BOUND_MS);
        }),
      ]);
      expect(stopped).toBe(true);
      expect(child.signalCode).toBe("SIGKILL");
    } finally {
      // A red run is no excuse to leave the ignorer behind.
      killPid(child.pid ?? -1, group, "SIGKILL");
      await Promise.race([
        closed,
        new Promise<void>((resolve) => {
          setTimeout(resolve, 5_000);
        }),
      ]);
    }
  }, 30_000);
});
