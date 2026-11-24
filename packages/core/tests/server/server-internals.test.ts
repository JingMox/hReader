// 这层管：`server.ts` 两条"公开 API 到不了的兜底支"——按 R7 抽成 `@internal` 导出后单测。
// 从 `../../src/server/server` 直接引入（**不走** `@hreader/core` 公共面）：它们不属于对外契约，
// 只是把 `req.url ?? "/"` 与 `address === null | string` 这两种解析器/运行时不变量提出来可测。

import { describe, expect, it } from "vitest";

import { baseUrlOf, portFrom } from "../../src/server/server";

describe("baseUrlOf · 请求行缺失时的基地址", () => {
  it("should fall back to / when the raw url is undefined", () => {
    const url = baseUrlOf(undefined, 7421);

    expect(url.href).toBe("http://127.0.0.1:7421/");
    expect(url.pathname).toBe("/");
  });

  it("should keep the path and query of a real request line", () => {
    const url = baseUrlOf("/api/doc/doc.html/outline?last=7", 7421);

    expect(url.origin).toBe("http://127.0.0.1:7421");
    expect(url.pathname).toBe("/api/doc/doc.html/outline");
    expect(url.search).toBe("?last=7");
  });

  it("should keep a bare origin-form path untouched", () => {
    expect(baseUrlOf("/api/events", 7421).href).toBe("http://127.0.0.1:7421/api/events");
  });
});

describe("portFrom · 监听端口的三种形态", () => {
  it("should use the fallback when the server is not listening", () => {
    expect(portFrom(null, 9)).toBe(9);
  });

  it("should use the fallback for a unix socket path", () => {
    expect(portFrom("/tmp/hr.sock", 9)).toBe(9);
  });

  it("should use the port the address reports, even when it is 0", () => {
    expect(portFrom({ address: "127.0.0.1", family: "IPv4", port: 0 }, 9)).toBe(0);
    expect(portFrom({ address: "::1", family: "IPv6", port: 61_234 }, 9)).toBe(61_234);
  });
});
