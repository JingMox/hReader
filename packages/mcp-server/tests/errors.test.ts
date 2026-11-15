// 这层管：工具结果的两副面孔与日志落点（AC-3/AC-4）——失败保留 `HrError.code`，堆栈只进 stderr。

import { HrError } from "@hreader/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { failureOf, okResult } from "../src/errors";
import { logFailure, logLine, messageOf } from "../src/log";

const stderrText = (): { read(): string } => {
  const written: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  return { read: () => written.join("") };
};

const textOf = (result: { content: readonly unknown[] }): string =>
  result.content
    .flatMap((one) =>
      typeof one === "object" && one !== null && "text" in one && typeof one.text === "string"
        ? [one.text]
        : [],
    )
    .join("\n");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("okResult", () => {
  it("should pretty-print the payload and keep ui meta optional", () => {
    expect(textOf(okResult({ a: 1 }))).toBe('{\n  "a": 1\n}');
    expect(okResult({ a: 1 })._meta).toBeUndefined();
    expect(okResult({ a: 1 }, { ui: { resourceUri: "ui://x" } })._meta).toEqual({
      ui: { resourceUri: "ui://x" },
    });
  });
});

describe("failureOf", () => {
  it("should keep the HrError code in the body and the stack out of it", () => {
    const stderr = stderrText();
    const result = failureOf("hr_probe", new HrError("io_failure", "写不进去"));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("[io_failure] 写不进去");
    expect(stderr.read()).toContain("hr_probe 失败");
    expect(stderr.read()).toContain("at ");
  });

  it("should fall back to the internal code for a plain error and a bare throw", () => {
    stderrText();
    expect(textOf(failureOf("hr_probe", new Error("boom")))).toBe("[internal] boom");
    expect(textOf(failureOf("hr_probe", "裸字符串"))).toBe("[internal] 裸字符串");
  });
});

describe("log", () => {
  it("should prefix every line and never touch stdout", () => {
    const stderr = stderrText();
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    logLine("就绪");
    logFailure("hr_probe", "裸字符串");

    expect(stderr.read()).toContain("[hreader-mcp] 就绪");
    expect(stderr.read()).toContain("[hreader-mcp] hr_probe 失败：裸字符串");
    expect(stdout).not.toHaveBeenCalled();
  });

  it("should stringify a non-Error reason", () => {
    expect(messageOf("裸字符串")).toBe("裸字符串");
    expect(messageOf(new Error("boom"))).toBe("boom");
  });
});
