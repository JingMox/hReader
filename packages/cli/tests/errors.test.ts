// 这层管：`errors.ts` 的错误文本收敛（首行截断 / unknown 归一）；纯函数，零 I/O。
import { describe, expect, it } from "vitest";

import { HrError } from "@hreader/core";

import { HintedError, firstErrorLineOf, messageOf } from "../src/errors";

describe("firstErrorLineOf", () => {
  it("取首个非空行（跳过前导空行）", () => {
    expect(firstErrorLineOf("\n\n  \nfirst\nsecond")).toBe("first");
  });

  it("全是空白时回空串", () => {
    expect(firstErrorLineOf("")).toBe("");
    expect(firstErrorLineOf("\n\n")).toBe("");
  });

  it("超过 200 字的行截到 200", () => {
    const long = "x".repeat(250);
    expect(firstErrorLineOf(long)).toHaveLength(200);
  });
});

describe("messageOf", () => {
  it("Error 取 message", () => {
    expect(messageOf(new Error("boom"))).toBe("boom");
  });

  it("非 Error 走 String 归一", () => {
    expect(messageOf("plain")).toBe("plain");
    expect(messageOf(42)).toBe("42");
  });
});

describe("HintedError", () => {
  it("keeps the wrapped error's code, message and data", () => {
    const base = new HrError("invalid_selector", "bad", {
      data: { reason: "syntax", count: 3 },
    });
    const wrapped = new HintedError(base, "hint\n");

    expect(wrapped).toBeInstanceOf(HrError);
    expect(wrapped.code).toBe("invalid_selector");
    expect(wrapped.message).toBe("bad");
    expect(wrapped.data).toEqual({ reason: "syntax", count: 3 });
    expect(wrapped.hint).toBe("hint\n");
    expect(wrapped.cause).toBe(base);
  });

  it("omits the data key when the wrapped error has none", () => {
    const wrapped = new HintedError(new HrError("invalid_document", "nope"), "hint\n");

    expect(wrapped.data).toBeUndefined();
  });
});
