// This layer covers `hr thumb` argv → intent (optional --out, timeout, switches); no filesystem.
import { describe, expect, it } from "vitest";

import { CWD, expectFailure, parse } from "./args-helpers";

const okOf = (argv: readonly string[]) => {
  const result = parse(argv);
  if (!result.ok) throw new Error(`expected parse to succeed: ${result.message}`);
  if (result.intent.kind !== "thumb")
    throw new Error(`expected a thumb intent: ${result.intent.kind}`);
  return result.intent;
};

describe("parseArgs · hr thumb defaults", () => {
  it("should default --out to stdout mode, timeout 60s, no force/json", () => {
    const intent = okOf(["thumb", "a.html"]);
    expect(intent.out).toBeUndefined();
    expect(intent.timeoutMs).toBe(60_000);
    expect(intent.visual).toBeUndefined();
    expect(intent.force).toBe(false);
    expect(intent.json).toBe(false);
    expect(intent.path).toBe(`${CWD}/a.html`);
    expect(intent.workspace).toBe(CWD);
  });
});

describe("parseArgs · hr thumb passthrough", () => {
  it("should pass --out/--visual/--timeout/--force/--json/--workspace through", () => {
    const intent = okOf([
      "thumb",
      "a.html",
      "--out",
      "shots/a.png",
      "--visual",
      "dark",
      "--timeout",
      "30",
      "--force",
      "--json",
      "--workspace",
      "/repo/docs",
    ]);
    expect(intent.out).toBe("/repo/shots/a.png");
    expect(intent.visual).toBe("dark");
    expect(intent.timeoutMs).toBe(30_000);
    expect(intent.force).toBe(true);
    expect(intent.json).toBe(true);
    expect(intent.workspace).toBe("/repo/docs");
  });

  it("should treat an empty --out as stdout mode, same as hr export", () => {
    expect(okOf(["thumb", "a.html", "--out", ""]).out).toBeUndefined();
  });
});

describe("parseArgs · hr thumb usage errors", () => {
  it("should reject a missing file", () => {
    expectFailure(["thumb"], "thumb 缺少 <file>", "thumb");
  });

  it("should reject extra positional arguments", () => {
    expectFailure(["thumb", "a.html", "b.html"], "thumb 只接受 1 个位置参数，多出 1 个", "thumb");
  });

  it("should reject an empty --visual", () => {
    expectFailure(["thumb", "a.html", "--visual", ""], "--visual 不能为空", "thumb");
  });

  it("should reject unknown flags", () => {
    const result = parse(["thumb", "a.html", "--page-size", "a4"]);
    expect(result.ok).toBe(false);
    expectFailure(["thumb", "a.html", "--width", "800"], "--width", "thumb");
  });

  it.each([["0"], ["601"], ["1.5"], ["abc"]])(
    "should reject --timeout %s as a usage error",
    (value) => {
      expectFailure(
        ["thumb", "a.html", "--timeout", value],
        "--timeout 必须是 1..600 的整数",
        "thumb",
      );
    },
  );
});
