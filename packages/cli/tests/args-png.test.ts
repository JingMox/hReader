// This layer covers `hr png` argv → intent (width/scale/height cap/timeout/absolute path/switches); no filesystem.
import { describe, expect, it } from "vitest";

import { CWD, expectFailure, parse } from "./args-helpers";

const okOf = (argv: readonly string[]) => {
  const result = parse(argv);
  if (!result.ok) throw new Error(`预期解析成功：${result.message}`);
  if (result.intent.kind !== "png") throw new Error(`预期 png intent：${result.intent.kind}`);
  return result.intent;
};

describe("parseArgs · hr png defaults", () => {
  it("should default to width 1200 / scale 2 / height cap 20000 / timeout 60s", () => {
    const intent = okOf(["png", "a.html", "--out", "out/a.png"]);
    expect([intent.width, intent.scale, intent.maxHeight, intent.timeoutMs]).toEqual([
      "1200",
      "2",
      "20000",
      60_000,
    ]);
    // No --max-height given: the default is only a fallback, not a user request to pre-check area against.
    expect(intent.maxHeightExplicit).toBe(false);
    expect(intent.path).toBe(`${CWD}/a.html`);
    expect(intent.out).toBe(`${CWD}/out/a.png`);
    expect(intent.force).toBe(false);
    expect(intent.json).toBe(false);
    expect(intent.workspace).toBe(CWD);
  });
});

describe("parseArgs · hr png outline flags", () => {
  it("should pass both outline flags into the intent as known flags without flagging them unused here", () => {
    // png has no outline: the real refusal is the command layer's `invalid_input` exit 1 (not usage error exit 2).
    expect(okOf(["png", "a.html", "--out", "a.png", "--no-outline"]).outlineFlag).toBe(
      "--no-outline",
    );
    expect(okOf(["png", "a.html", "--out", "a.png", "--outline"]).outlineFlag).toBe("--outline");
    expect(okOf(["png", "a.html", "--out", "a.png"]).outlineFlag).toBeUndefined();
  });
});

describe("parseArgs · hr png passthrough", () => {
  it("should pass through all four values and both switches", () => {
    const intent = okOf([
      "png",
      "a.html",
      "--out",
      "a.png",
      "--width",
      "256",
      "--scale",
      "3",
      "--max-height",
      "50000",
      "--timeout",
      "30",
      "--force",
      "--json",
      "--workspace",
      "/repo/docs",
    ]);
    expect([intent.width, intent.scale, intent.maxHeight, intent.timeoutMs]).toEqual([
      "256",
      "3",
      "50000",
      30_000,
    ]);
    expect(intent.maxHeightExplicit).toBe(true);
    expect(intent.force).toBe(true);
    expect(intent.json).toBe(true);
    expect(intent.workspace).toBe("/repo/docs");
  });
});

describe("parseArgs · hr png usage errors", () => {
  it("should reject a missing file", () => {
    expectFailure(["png", "--out", "a.png"], "png 缺少 <file>", "png");
  });

  it("should reject a missing --out", () => {
    expectFailure(["png", "a.html"], "png 缺少 --out <path>", "png");
  });

  it("should reject extra positional arguments", () => {
    expectFailure(
      ["png", "a.html", "b.html", "--out", "a.png"],
      "png 只接受 1 个位置参数，多出 1 个",
      "png",
    );
  });

  it("should reject unknown flags", () => {
    const result = parse(["png", "a.html", "--out", "a.png", "--page-size", "a4"]);
    expect(result.ok).toBe(false);
  });

  it.each([["0"], ["601"], ["1.5"], ["abc"]])(
    "should reject --timeout %s as a usage error",
    (value) => {
      expectFailure(
        ["png", "a.html", "--out", "a.png", "--timeout", value],
        "--timeout 必须是 1..600 的整数",
        "png",
      );
    },
  );

  it("should leave three out-of-range dimensions to the command layer's invalid_input", () => {
    expect(okOf(["png", "a.html", "--out", "a.png", "--width", "99999"]).width).toBe("99999");
  });
});
