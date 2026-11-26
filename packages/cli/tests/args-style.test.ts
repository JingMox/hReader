// This layer covers the `parseArgs` style subcommand (mode exclusivity and positional args); no subprocess, no fs.

import { describe, it } from "vitest";

import { expectFailure, parse } from "./args-helpers";

import { expect } from "vitest";

describe("parseArgs · style", () => {
  it.each([
    ["--visual", "atelier-editorial", { kind: "visual", id: "atelier-editorial" }],
    ["--tone", "atelier-editorial", { kind: "tone", id: "atelier-editorial" }],
    ["--lint", undefined, { kind: "lint" }],
  ] as const)("should parse %s mode", (flag, value, mode) => {
    const argv = value === undefined ? ["style", "a.html", flag] : ["style", "a.html", flag, value];
    expect(parse(argv)).toMatchObject({ ok: true, intent: { kind: "style", mode } });
  });

  it.each([
    [["style"], "style 缺少 <file>"],
    [["style", "a"], "style 需要 --visual <id> / --tone <id> / --lint 之一"],
    [["style", "a", "b", "--lint"], "style 只接受 1 个位置参数，多出 1 个"],
    [["style", "a", "--lint", "--json", "--json", "b"], "style 只接受 1 个位置参数，多出 1 个"],
    [["style", "a", "--html", "x"], "--html"],
  ])("should reject %j", (argv, message) => {
    expectFailure(argv, message, "style");
  });

  it.each([["--strict"], ["--strict=warning"]] as const)("should accept %s with --lint", (flag) => {
    expect(parse(["style", "a.html", "--lint", flag])).toMatchObject({
      ok: true,
      intent: { kind: "style", mode: { kind: "lint" } },
    });
  });

  it("should reject --strict without --lint", () => {
    expectFailure(
      ["style", "a.html", "--visual", "x", "--strict"],
      "--strict 只与 --lint 同用",
      "style",
    );
  });

  it("should reject an unknown --strict value", () => {
    expectFailure(
      ["style", "a.html", "--lint", "--strict=foo"],
      "未知的 --strict：foo（可选：error | warning）",
      "style",
    );
  });

  it("should reject mode flags that are combined", () => {
    expectFailure(
      ["style", "a", "--lint", "--visual", "x"],
      "--visual / --tone / --lint 必须且只能给一个",
      "style",
    );
    expectFailure(
      ["style", "a", "--visual", "x", "--tone", "y", "--json"],
      "--visual / --tone / --lint 必须且只能给一个",
      "style",
    );
  });
});
