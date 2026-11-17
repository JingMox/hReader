// 这层管：`protocol.ts` 的纯函数（构造/解析/首行截断）；零 I/O，不需要任何传输。
import { describe, expect, it } from "vitest";

import { cdpCallOf, fieldOf, firstErrorLineOf, listOf, replyOf } from "../src/chrome/protocol";

describe("cdpCallOf", () => {
  it("不带会话时只构造 id/method/params", () => {
    expect(JSON.parse(cdpCallOf(7, "Page.enable", {}))).toEqual({
      id: 7,
      method: "Page.enable",
      params: {},
    });
  });

  it("扁平会话把 sessionId 挂在报文顶层，不塞进 params", () => {
    const message: unknown = JSON.parse(
      cdpCallOf(8, "Page.navigate", { url: "file:///a.html" }, "s1"),
    );
    expect(fieldOf(message, "sessionId")).toBe("s1");
    expect(fieldOf(message, "params")).toEqual({ url: "file:///a.html" });
  });
});

describe("replyOf · reply/error", () => {
  it("id 命中时给 reply，result 缺失按空对象", () => {
    expect(replyOf('{"id":3,"result":{"frameId":"f1"}}')).toEqual({
      kind: "reply",
      id: 3,
      result: { frameId: "f1" },
    });
    expect(replyOf('{"id":4}')).toEqual({ kind: "reply", id: 4, result: {} });
  });

  it("带 error 的报文给 error，message 只留首行", () => {
    expect(replyOf('{"id":5,"error":{"message":"boom\\nsecond line","code":-1}}')).toEqual({
      kind: "error",
      id: 5,
      message: "boom",
    });
  });

  it("error 没有字符串 message 时给兜底文案", () => {
    expect(replyOf('{"id":6,"error":{}}')).toEqual({
      kind: "error",
      id: 6,
      message: "未知的 CDP 错误",
    });
    expect(replyOf('{"id":7,"error":"text"}')).toEqual({
      kind: "error",
      id: 7,
      message: "未知的 CDP 错误",
    });
  });
});

describe("replyOf · event/invalid", () => {
  it("method 命中时给 event", () => {
    expect(replyOf('{"method":"Page.loadEventFired","params":{"timestamp":1}}')).toEqual({
      kind: "event",
      method: "Page.loadEventFired",
      params: { timestamp: 1 },
    });
    expect(replyOf('{"method":"Page.frameDetached"}')).toEqual({
      kind: "event",
      method: "Page.frameDetached",
      params: {},
    });
  });

  it("坏报文一律 invalid", () => {
    for (const raw of ["not json", "[]", "3", '"text"', "null", '{"id":"7"}', "{}"]) {
      expect(replyOf(raw)).toEqual({ kind: "invalid" });
    }
  });
});

describe("firstErrorLineOf", () => {
  it("取首个非空行并去尾部空白以外不动内容", () => {
    expect(firstErrorLineOf("\n\n  boom \nsecond")).toBe("  boom ");
  });

  it("超过 200 字只留前 200 字", () => {
    const line = "x".repeat(300);
    expect(firstErrorLineOf(`${line}\nnext`).length).toBe(200);
  });

  it("空文本给空串", () => {
    expect(firstErrorLineOf("\n \n")).toBe("");
  });
});

describe("fieldOf / listOf", () => {
  it("fieldOf 对非对象返回 undefined，不抛", () => {
    expect(fieldOf(undefined, "a")).toBeUndefined();
    expect(fieldOf("text", "length")).toBe(4);
  });

  it("listOf 把非数组与稀疏项摊平成 unknown[]", () => {
    expect(listOf("nope")).toEqual([]);
    expect(listOf([1, undefined])).toEqual([1, undefined]);
  });
});
