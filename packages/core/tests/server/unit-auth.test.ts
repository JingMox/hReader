// 这层管：`src/server/auth.ts` 的纯判定（Host/Origin/CSRF 与 cookie/token 比较）；不起 socket。

import { describe, expect, it } from "vitest";

import {
  cookieOf,
  csrfAllowed,
  hostAllowed,
  originAllowed,
  tokenMatches,
  COOKIE_NAME,
} from "../../src/server/auth";

const PORT = 7420;

describe("hostAllowed · 反 DNS-rebinding", () => {
  it.each([
    ["127.0.0.1:7420", true],
    ["localhost:7420", true],
    [" LOCALHOST:7420 ", true],
    ["127.0.0.1:7421", false],
    ["localhost", false],
    ["localhost:7420.evil.com", false],
    ["evil.com:7420", false],
    [undefined, false],
  ])("should treat Host %j as allowed=%s", (host, allowed) => {
    expect(hostAllowed(host, PORT)).toBe(allowed);
  });
});

describe("originAllowed · 跨站请求来源", () => {
  it.each([
    [undefined, true],
    ["http://127.0.0.1:7420", true],
    ["HTTP://LOCALHOST:7420", true],
    ["http://127.0.0.1:7421", false],
    ["https://127.0.0.1:7420", false],
    ["http://localhost:7420.evil.com", false],
    ["http://localhost.evil.com:7420", false],
    ["http://evil.com:7420", false],
    ["null", false],
  ])("should treat Origin %j as allowed=%s", (origin, allowed) => {
    expect(originAllowed(origin, PORT)).toBe(allowed);
  });
});

describe("cookieOf · 只取第一个同名 cookie", () => {
  it("should return undefined when the header is absent", () => {
    expect(cookieOf(undefined, COOKIE_NAME)).toBeUndefined();
  });

  it("should pick hr out of a multi-cookie header and trim spaces", () => {
    expect(cookieOf("a=1; hr=abc; b=2", COOKIE_NAME)).toBe("abc");
  });

  it("should not match a name that merely ends with the sought name", () => {
    expect(cookieOf("xhr=abc", COOKIE_NAME)).toBeUndefined();
    expect(cookieOf("a=1; hr=first; hr=second", COOKIE_NAME)).toBe("first");
  });

  it("should keep an empty value instead of treating it as missing", () => {
    expect(cookieOf("hr=", COOKIE_NAME)).toBe("");
  });
});

describe("tokenMatches · 定长比较", () => {
  it("should reject a missing token", () => {
    expect(tokenMatches(undefined, "a".repeat(32))).toBe(false);
  });

  it("should reject a token of the wrong length without leaking through a throw", () => {
    expect(tokenMatches("a".repeat(31), "a".repeat(32))).toBe(false);
    expect(tokenMatches("", "a".repeat(32))).toBe(false);
  });

  it("should compare equal strings as a match", () => {
    expect(tokenMatches("a".repeat(32), "a".repeat(32))).toBe(true);
  });

  it("should reject same-length differences", () => {
    expect(tokenMatches(`${"a".repeat(31)}b`, "a".repeat(32))).toBe(false);
  });
});

describe("csrfAllowed · 自定义头固定值", () => {
  it.each([
    ["1", true],
    ["0", false],
    ["", false],
    ["true", false],
    [undefined, false],
  ])("should treat X-HR-CSRF %j as allowed=%s", (value, allowed) => {
    expect(csrfAllowed(value)).toBe(allowed);
  });
});
