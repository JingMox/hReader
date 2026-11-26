// This layer holds real temp dirs shared by serve tests and "how to stop it" (no assertion decisions).

import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MockInstance } from "vitest";
import { vi } from "vitest";

import { serveCommand, type ServeInput } from "../src/commands/serve";
import { PARENT_POLL_MS } from "../src/parent-guard";

export const DOC =
  '<!doctype html><html><body><article data-hr-id="hr-a"><p>x</p></article></body></html>';

export interface ServeDirs {
  readonly workspace: string;
  readonly home: string;
  readonly drop: () => void;
}

/** A real directory set: `doc.html` already sits in workspace, home is empty waiting for `daemon.json`. */
export const serveDirs = (): ServeDirs => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "hr-serve-ws-")));
  const home = realpathSync(mkdtempSync(join(tmpdir(), "hr-serve-home-")));
  writeFileSync(join(workspace, "doc.html"), DOC, "utf8");
  return {
    workspace,
    home,
    drop: () => {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
};

export interface StopHandle {
  readonly stop: () => void;
  readonly stopped: Promise<void>;
}

export const stopHandle = (): StopHandle => {
  let stop: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  return { stop, stopped: stopped };
};

/** daemon.json cleanup after `await stop` is an async chain: poll until the file is really gone before asserting (3s bound), never guess fixed milliseconds. */
export const waitGone = async (path: string): Promise<void> => {
  const deadline = Date.now() + 3_000;
  while (existsSync(path) && Date.now() < deadline) {
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
};

/** The fixed `launchParentPid` is a real pid (this process's parent); cases playing "parent is dead" spread-override it. */
export const serveInputOf = (
  dir: { readonly workspace: string; readonly home: string },
  json: boolean,
  stop: Promise<void>,
): ServeInput => ({
  file: "doc.html",
  workspace: dir.workspace,
  home: dir.home,
  port: 0,
  json,
  stop,
  exitWithParent: false,
  launchParentPid: process.ppid,
});

/** Count only the parent-death timer: core's own timers do not count. */
export const pollTimers = (spy: MockInstance<typeof globalThis.setInterval>): number =>
  spy.mock.calls.filter((call) => call[1] === PARENT_POLL_MS).length;

/** Pull the parent-death timer out of `setInterval`'s return (asserting who cleared it needs this handle). */
export const pollTimerOf = (spy: MockInstance<typeof globalThis.setInterval>): unknown => {
  const index = spy.mock.calls.findIndex((call) => call[1] === PARENT_POLL_MS);
  return index === -1 ? undefined : spy.mock.results[index]?.value;
};

/** The callback the watchdog runs each poll: real-serving cases advance "one poll" manually through it (no fake clock). */
export const pollCallbackOf = (
  spy: MockInstance<typeof globalThis.setInterval>,
): (() => void) | undefined => spy.mock.calls.find((call) => call[1] === PARENT_POLL_MS)?.[0];

/**
 * Whether the timer still holds the event loop: false after `unref()`. Fake timers cannot see ref state,
 * so asserting `unref()` must ask Node itself with a real timer.
 */
export const timerStillHoldsProcess = (timer: unknown): boolean => {
  const hasRef: unknown = Reflect.get(Object(timer), "hasRef");
  if (typeof hasRef !== "function")
    throw new TypeError("timer has no hasRef(): cannot prove unref()");
  return Reflect.apply(hasRef, timer, []) === true;
};

/** Start a server with the parent-death watchdog and hand back two timer spies plus the watchdog handle (assertions belong to the caller). */
export const startWatched = async (dir: ServeDirs, stopped: Promise<void>) => {
  const setSpy = vi.spyOn(globalThis, "setInterval");
  const clearSpy = vi.spyOn(globalThis, "clearInterval");
  await serveCommand({ ...serveInputOf(dir, true, stopped), exitWithParent: true });
  return { clearSpy, poll: pollCallbackOf(setSpy), setSpy, timer: pollTimerOf(setSpy) };
};
