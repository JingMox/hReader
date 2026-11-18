// 这层管：serve 系测试共享的真临时目录与"怎么让它停下"（无断言决策）。

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

/** 一套真目录：workspace 里已放好 `doc.html`，home 空着等 `daemon.json`。 */
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

/** `serveCommand` 收完尸体是 `await stop` 之后的微任务，等一小段再断言"文件没了"。 */
export const settle = async (): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, 50);
  });
};

/** 固定 `launchParentPid` 是个真 pid（本进程的父）；要演"父已死"的用例自己 spread 覆盖。 */
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

/** 只数 parent-death 那只定时器：core 自己的计时器不算。 */
export const pollTimers = (spy: MockInstance<typeof globalThis.setInterval>): number =>
  spy.mock.calls.filter((call) => call[1] === PARENT_POLL_MS).length;

/** 从 `setInterval` 的返回值里拿出 parent-death 那只定时器（断言它被谁清掉要靠这个句柄）。 */
export const pollTimerOf = (spy: MockInstance<typeof globalThis.setInterval>): unknown => {
  const index = spy.mock.calls.findIndex((call) => call[1] === PARENT_POLL_MS);
  return index === -1 ? undefined : spy.mock.results[index]?.value;
};

/** 看门狗每次轮询跑的那个回调：真起服务时靠它把"一次 poll"手动推进（不用假时钟）。 */
export const pollCallbackOf = (
  spy: MockInstance<typeof globalThis.setInterval>,
): (() => void) | undefined => spy.mock.calls.find((call) => call[1] === PARENT_POLL_MS)?.[0];

/**
 * 定时器还拽着事件循环没有：`unref()` 之后是 false。fake timer 下看不到 ref 状态，
 * 所以断言 `unref()` 只能用真定时器问 Node 本人。
 */
export const timerStillHoldsProcess = (timer: unknown): boolean => {
  const hasRef: unknown = Reflect.get(Object(timer), "hasRef");
  if (typeof hasRef !== "function") throw new TypeError("timer 没有 hasRef()：无法证明 unref()");
  return Reflect.apply(hasRef, timer, []) === true;
};

/** 起一个带 parent-death 看门狗的服务，顺手交出两只定时器 spy 与看门狗句柄（断言归调用方）。 */
export const startWatched = async (dir: ServeDirs, stopped: Promise<void>) => {
  const setSpy = vi.spyOn(globalThis, "setInterval");
  const clearSpy = vi.spyOn(globalThis, "clearInterval");
  await serveCommand({ ...serveInputOf(dir, true, stopped), exitWithParent: true });
  return { clearSpy, poll: pollCallbackOf(setSpy), setSpy, timer: pollTimerOf(setSpy) };
};
