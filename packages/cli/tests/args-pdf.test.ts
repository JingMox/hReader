// This layer covers `hr pdf` argv → intent (paper/timeout/absolute path/switches); no filesystem.
import { describe, expect, it } from "vitest";

import { CWD, expectFailure, parse } from "./args-helpers";

const okOf = (argv: readonly string[]) => {
  const result = parse(argv);
  if (!result.ok) throw new Error(`预期解析成功：${result.message}`);
  if (result.intent.kind !== "pdf") throw new Error(`预期 pdf intent：${result.intent.kind}`);
  return result.intent;
};

describe("parseArgs · hr pdf defaults", () => {
  it("should default paper to a4, timeout to 60s, and resolve the path to absolute", () => {
    const intent = okOf(["pdf", "a.html", "--out", "out/a.pdf"]);
    expect(intent.pageSize).toBe("a4");
    expect(intent.timeoutMs).toBe(60_000);
    expect(intent.path).toBe(`${CWD}/a.html`);
    expect(intent.out).toBe(`${CWD}/out/a.pdf`);
    expect(intent.force).toBe(false);
    expect(intent.json).toBe(false);
    expect(intent.workspace).toBe(CWD);
  });

  it("should pass through all three switches and --workspace", () => {
    const intent = okOf([
      "pdf",
      "a.html",
      "--out",
      "a.pdf",
      "--page-size",
      "letter",
      "--timeout",
      "30",
      "--force",
      "--json",
      "--workspace",
      "/repo/docs",
    ]);
    expect(intent.pageSize).toBe("letter");
    expect(intent.timeoutMs).toBe(30_000);
    expect(intent.force).toBe(true);
    expect(intent.json).toBe(true);
    expect(intent.workspace).toBe("/repo/docs");
  });

  it("should keep absolute paths verbatim", () => {
    const intent = okOf(["pdf", "/tmp/a.html", "--out", "/tmp/a.pdf"]);
    expect(intent.path).toBe("/tmp/a.html");
    expect(intent.out).toBe("/tmp/a.pdf");
  });
});

describe("parseArgs · hr pdf outline flags", () => {
  it("should default the outline to on when no outline flag is given (--outline is the on-state default)", () => {
    const intent = okOf(["pdf", "a.html", "--out", "a.pdf"]);
    expect(intent.outline).toBe(true);
    expect(intent.outlineConflict).toBe(false);
  });

  it("should stay on and mark no conflict when --outline is given explicitly", () => {
    const intent = okOf(["pdf", "a.html", "--out", "a.pdf", "--outline"]);
    expect(intent.outline).toBe(true);
    expect(intent.outlineConflict).toBe(false);
  });

  it("should turn the outline off with --no-outline", () => {
    const intent = okOf(["pdf", "a.html", "--out", "a.pdf", "--no-outline"]);
    expect(intent.outline).toBe(false);
    expect(intent.outlineConflict).toBe(false);
  });

  it("should only mark a conflict in the intent when both are given (`invalid_input` exit 1 belongs to the command layer)", () => {
    const intent = okOf(["pdf", "a.html", "--out", "a.pdf", "--outline", "--no-outline"]);
    expect(intent.outlineConflict).toBe(true);
  });
});

describe("parseArgs · hr pdf usage errors", () => {
  it("should reject a missing file", () => {
    expectFailure(["pdf", "--out", "a.pdf"], "pdf 缺少 <file>", "pdf");
  });

  it("should reject a missing --out", () => {
    expectFailure(["pdf", "a.html"], "pdf 缺少 --out <path>", "pdf");
  });

  it("should treat an empty --out string as missing", () => {
    expectFailure(["pdf", "a.html", "--out", ""], "pdf 缺少 --out <path>", "pdf");
  });

  it("should reject extra positional arguments", () => {
    expectFailure(
      ["pdf", "a.html", "b.html", "--out", "a.pdf"],
      "pdf 只接受 1 个位置参数，多出 1 个",
      "pdf",
    );
  });

  it("should reject unknown switches", () => {
    expectFailure(["pdf", "a.html", "--out", "a.pdf", "--width", "800"], "--width", "pdf");
  });

  it.each(["0", "601", "1.5", "abc", "-3"])(
    "should reject --timeout %s as out of range",
    (value) => {
      expectFailure(
        ["pdf", "a.html", "--out", "a.pdf", "--timeout", value],
        "--timeout 必须是 1..600 的整数秒",
        "pdf",
      );
    },
  );
});
