// 这层管：`paramOf`（`packages/core/src/server/routes.ts`）——路由具名参数取值。
// R3 把逐点 `params[key] ?? fallback` 换成这个循环，**两条臂都必须真跑**：
// 命中（返回实际值）与缺失（返回 fallback）。否则等于把死码搬了个家。

import { describe, expect, it } from "vitest";

import { paramOf } from "../../src/server/routes";

describe("paramOf · 命中与缺失", () => {
  it("should return the value when the key is present", () => {
    expect(paramOf({ docId: "a.html", anId: "an-1" }, "docId", "fallback.html")).toBe("a.html");
    expect(paramOf({ docId: "a.html", anId: "an-1" }, "anId", "")).toBe("an-1");
  });

  it("should return the fallback when the key is missing", () => {
    // 缺失是真路径（`dispatch(route, {}, req)` 这类直调），不是理论上不可能。
    expect(paramOf({}, "docId", "doc.html")).toBe("doc.html");
    expect(paramOf({ anId: "an-1" }, "docId", "doc.html")).toBe("doc.html");
  });

  it("should not be fooled by a value that equals the fallback", () => {
    // 命中但值恰好等于 fallback：必须原样返回（不能靠“值等于 fallback 就算缺失”）。
    expect(paramOf({ docId: "doc.html" }, "docId", "doc.html")).toBe("doc.html");
  });

  it("should ignore inherited-ish keys not in the record and keep the first match", () => {
    expect(paramOf({ docId: "first.html", "0": "zero" }, "docId", "fb.html")).toBe("first.html");
  });

  it("should return an empty-string value rather than the fallback", () => {
    // `""` 是**存在**的键值：退化到 fallback 会把空参数悄悄换成别的文档名。
    expect(paramOf({ docId: "" }, "docId", "doc.html")).toBe("");
  });
});
