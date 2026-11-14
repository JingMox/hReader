// 这层管：`flashChanged`（`packages/app/src/flash.ts`）的类时长与取消——注入式调度器，不真等 2s。
// 从 `notes-widgets.test.ts` 拆出来是为了守住单文件 300 行的上限。

import { describe, expect, it, vi } from "vitest";

import { flashChanged } from "../src/flash.ts";
import { createFakeHost } from "./support/fake-host.ts";

const hostOf = () => createFakeHost();
const callsOf = (host: ReturnType<typeof hostOf>, op: string): readonly (readonly unknown[])[] =>
  host.calls.filter((call) => call.op === op).map((call) => call.args);

describe("flashChanged", () => {
  const flashOf = (host: ReturnType<typeof hostOf>): readonly (readonly unknown[])[] =>
    callsOf(host, "cls").filter((args) => args[1] === "hr-flash");

  it("should add the class now and schedule the removal at 2000ms", () => {
    const host = hostOf();
    const runs: (() => void)[] = [];
    const delays: number[] = [];
    flashChanged(host.host, ["hr-a", "hr-b"], (ms, run) => {
      delays.push(ms);
      runs.push(run);
      return () => undefined;
    });

    expect(flashOf(host)).toEqual([
      ['[data-hr-id="hr-a"]', "hr-flash", "1"],
      ['[data-hr-id="hr-b"]', "hr-flash", "1"],
    ]);
    expect(delays).toEqual([2000, 2000]);

    runs[0]?.();
    expect(flashOf(host).at(-1)).toEqual(['[data-hr-id="hr-a"]', "hr-flash", "0"]);
  });

  it("should cancel every pending removal", () => {
    const host = hostOf();
    const cancellers = [vi.fn((): void => undefined), vi.fn((): void => undefined)];
    let next = 0;
    const cancel = flashChanged(
      host.host,
      ["hr-a", "hr-b"],
      () => cancellers[next++] ?? (() => undefined),
    );
    cancel();

    expect(cancellers.map((one) => one.mock.calls.length)).toEqual([1, 1]);
    expect(flashOf(host)).toHaveLength(2);
  });
});
