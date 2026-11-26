// This layer: spawn a background `hr serve` subprocess and wait for it to print its
// address (test-only); makes no assertions.
//
// Two hard rules — each has deadlocked a run before:
//   1. **Never run `serve` in the foreground** — it never exits and the parent waits
//      forever; always spawn and kill in a finally.
//   2. Always pass `--port 0` (OS-assigned) and let serve print the real port; the test
//      reads it from the output, never races other cases on a fixed port, and never hits
//      a stale daemon left on the machine.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { killPid, registerChild } from "../../../tests/leak-guard/registry.ts";
import { fieldOf, MAIN } from "./harness.ts";

const START_TIMEOUT_MS = 15_000;

/** A subprocess started with `stdio: ["ignore","pipe","pipe"]`: stdin is null, so it cannot be typed `WithoutNullStreams`. */
type ServeChild = ChildProcessByStdio<null, Readable, Readable>;

export interface ServeHandle {
  /** The printed address (the string in the human line, with trailing slash). */
  readonly url: string;
  readonly port: number;
  /** Only available in `--json` mode: the token inside `{url,port,token,pid,workspace}`. */
  readonly token: string;
  readonly stop: () => Promise<void>;
}

interface ServeOptions {
  /** `--json`: stdout is `{ok,data:{url,port,token,pid,workspace}}`; otherwise the human `serving … on <url> (pid n)`. */
  readonly json: boolean;
  /** daemon.json's parent directory; must already exist (the CLI checks). */
  readonly home: string;
  /** The subprocess working directory; document paths resolve relative to it. */
  readonly cwd: string;
}

const addressOf = (line: string): { url: string; port: number; token: string } => {
  if (line.startsWith("{")) {
    const data = fieldOf(JSON.parse(line), "data");
    return {
      // Read the string the program itself printed: a lost `?token=` should surface here, not be rebuilt by the test.
      url: String(fieldOf(data, "url")),
      port: Number(fieldOf(data, "port")),
      token: String(fieldOf(data, "token")),
    };
  }
  // `serving <workspace> on http://127.0.0.1:<port>/ (pid <n>)`
  const url = /on (http:\/\/\S+)/u.exec(line)?.[1] ?? "";
  if (url === "") throw new Error(`serve did not print an address: ${line}`);
  return { url, port: Number(/127\.0\.0\.1:(\d+)/u.exec(url)?.[1] ?? "0"), token: "" };
};

const STOP_GRACE_MS = 3_000;

const childGroup = (child: ServeChild): boolean =>
  process.platform !== "win32" && child.pid !== undefined;

/** SIGTERM the group, wait at most `STOP_GRACE_MS`, then SIGKILL the group: a signal-ignoring serve must not hang the suite. */
export const stopOf =
  (child: ServeChild): (() => Promise<void>) =>
  async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once("close", () => {
        resolve();
      });
      killPid(child.pid ?? -1, childGroup(child), "SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          killPid(child.pid ?? -1, childGroup(child), "SIGKILL");
        }
      }, STOP_GRACE_MS);
    });
  };

/** Wait for the first stdout line and parse the address; all of stderr is kept and folded into the error on timeout or early exit. */
const firstLineOf = (child: ServeChild): Promise<{ url: string; port: number; token: string }> =>
  new Promise((resolve, reject) => {
    let buffered = "";
    let stderr = "";
    const timer = setTimeout(() => {
      reject(
        new Error(`serve did not print an address within ${String(START_TIMEOUT_MS)}ms: ${stderr}`),
      );
    }, START_TIMEOUT_MS);
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      reject(new Error(`serve exited early (code ${String(code)}): ${stderr}`));
    });
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(timer);
      try {
        resolve(addressOf(buffered.slice(0, newline)));
      } catch (error: unknown) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });

export const startServe = async (file: string, options: ServeOptions): Promise<ServeHandle> => {
  const args = ["serve", file, "--port", "0", "--home", options.home];
  if (options.json) args.push("--json");
  // When the spawning process dies (worker killed, crashed, interrupted) the
  // daemon must reap itself via --exit-with-parent — no relying on an afterAll
  // that may never run.
  args.push("--exit-with-parent");
  const child = spawn(process.execPath, ["--experimental-strip-types", MAIN, ...args], {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  registerChild(child, { group: process.platform !== "win32" });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  try {
    return { ...(await firstLineOf(child)), stop: stopOf(child) };
  } catch (error: unknown) {
    // Failed start-up (timeout / early exit / malformed receipt) must reap the spawned process before rethrowing.
    killPid(child.pid ?? -1, childGroup(child), "SIGKILL");
    throw error;
  }
};

/** The directory `serve --home` points at must exist; build a private home anyway so it never collides with a real daemon on this machine. */
export const homeOf = (dir: string): string => {
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  return home;
};
