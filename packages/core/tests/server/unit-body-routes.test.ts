// 这层管：`src/server/body.ts` 与 `routes.ts` 的纯函数（JSON 取字段 / 路由匹配 / 参数解码）。

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { codeOf } from "../io/harness";
import { HrError } from "../../src/hr-error";
import {
  integer,
  MAX_BODY_BYTES,
  optionalString,
  parseBody,
  requiredString,
} from "../../src/server/body";
import { decodeParams, matchRoute, ROUTES } from "../../src/server/routes";

const schema = z.object({
  s: requiredString,
  n: integer,
  o: optionalString,
  kind: requiredString.pipe(z.enum(["a", "b"])),
});

const GOOD = { s: "x", n: 3, kind: "a" };

const messageOf = (body: unknown): string => {
  try {
    parseBody(schema, body);
  } catch (error: unknown) {
    if (error instanceof HrError) return error.message;
    throw error;
  }
  throw new Error("期望 invalid_request 但没有抛");
};

describe("parseBody · 字段取值与错误口径", () => {
  it("should return the typed fields and ignore unknown ones", () => {
    expect(parseBody(schema, { ...GOOD, extra: 1 })).toEqual(GOOD);
    expect(parseBody(schema, { ...GOOD, o: "note" }).o).toBe("note");
  });

  it("should treat a wrongly-typed optional string as absent", () => {
    expect(parseBody(schema, { ...GOOD, o: 5 }).o).toBeUndefined();
  });

  it("should reject every failure with invalid_request", () => {
    expect(codeOf(() => parseBody(schema, { ...GOOD, n: 1.5 }))).toBe("invalid_request");
  });

  it("should pin the 1 MiB body limit", () => {
    expect(MAX_BODY_BYTES).toBe(1_048_576);
  });
});

describe("parseBody · 报错文案", () => {
  it.each([
    ["缺失", { n: 3, kind: "a" }],
    ["空串", { ...GOOD, s: "" }],
    ["类型不对", { ...GOOD, s: 7 }],
  ])("should report a %s required string as missing", (_label, body) => {
    expect(messageOf(body)).toBe("缺少字符串字段 `s`");
  });

  it.each([
    ["小数", 1.5],
    ["字符串", "3"],
    ["无穷", Number.POSITIVE_INFINITY],
    ["缺失", undefined],
  ])("should report a %s integer as invalid", (_label, n) => {
    expect(messageOf({ ...GOOD, n })).toBe("字段 `n` 必须是整数");
  });

  it("should name an unknown enum value but treat an empty one as missing", () => {
    expect(messageOf({ ...GOOD, kind: "c" })).toBe("未知 kind：c");
    expect(messageOf({ ...GOOD, kind: "" })).toBe("缺少字符串字段 `kind`");
  });

  it("should report only the first failure", () => {
    expect(messageOf({})).toBe("缺少字符串字段 `s`");
  });
});

describe("matchRoute · 精确分段匹配", () => {
  it("should match the GET routes of the frozen table", () => {
    expect(matchRoute("GET", "/").kind).toBe("route");
    // RFC 9110 §9.1：method token 区分大小写——小写 `get` 不是 `GET`（llhttp 线上先拒，路由层再兜底 405）。
    expect(matchRoute("get", "/healthz").kind).toBe("method");
    expect(matchRoute("GET", "/s/doc.html")).toMatchObject({
      kind: "route",
      params: { docId: "doc.html" },
      route: { kind: "document", auth: "token" },
    });
  });
});

describe("matchRoute · 精确分段匹配（续）", () => {
  it("should match the POST routes and both document views", () => {
    expect(matchRoute("POST", "/api/patch")).toMatchObject({
      kind: "route",
      route: { kind: "patch", auth: "cookie+csrf" },
    });
    expect(matchRoute("POST", "/api/style").kind).toBe("route");
    expect(matchRoute("POST", "/api/annotation").kind).toBe("route");
    expect(matchRoute("GET", "/api/events").kind).toBe("route");
    expect(matchRoute("GET", "/api/doc/a/b/model").kind).toBe("none");
    expect(matchRoute("GET", "/api/doc/a.html/model").kind).toBe("route");
    expect(matchRoute("GET", "/api/doc/a.html/outline").kind).toBe("route");
    // 两条静态入口：/assets/<任意深度路径> 与内置主题的 CSS。
    expect(matchRoute("GET", "/assets/app/main.js")).toMatchObject({
      kind: "route",
      params: { path: "app/main.js" },
      route: { kind: "assets", auth: "none" },
    });
    expect(matchRoute("GET", "/api/theme/atelier-editorial")).toMatchObject({
      kind: "route",
      params: { styleId: "atelier-editorial" },
      route: { kind: "theme", auth: "none" },
    });
    expect(matchRoute("GET", "/api/theme")).toMatchObject({
      kind: "route",
      params: {},
      route: { kind: "themes", auth: "none" },
    });
  });
});

describe("matchRoute · 批注与撤销", () => {
  it("should match the five new POST/GET routes", () => {
    expect(matchRoute("GET", "/api/doc/a.html/annotations")).toMatchObject({
      kind: "route",
      params: { docId: "a.html" },
      route: { kind: "annotations", auth: "cookie" },
    });
    expect(matchRoute("POST", "/api/doc/a.html/annotations")).toMatchObject({
      kind: "route",
      route: { kind: "annotationAdd", auth: "cookie+csrf" },
    });
    expect(matchRoute("POST", "/api/doc/a.html/annotations/an-1a2b3c4d/resolve")).toMatchObject({
      kind: "route",
      params: { docId: "a.html", anId: "an-1a2b3c4d" },
      route: { kind: "annotationResolve", auth: "cookie+csrf" },
    });
    expect(matchRoute("GET", "/api/doc/a.html/notes/an-1a2b3c4d/diff")).toMatchObject({
      kind: "route",
      params: { docId: "a.html", anId: "an-1a2b3c4d" },
      route: { kind: "annotationDiff", auth: "cookie" },
    });
    expect(matchRoute("POST", "/api/doc/a.html/undo")).toMatchObject({
      kind: "route",
      route: { kind: "undo", auth: "cookie+csrf" },
    });
  });

  it("should match the trust and normalize write routes", () => {
    expect(matchRoute("POST", "/api/doc/a.html/trust")).toMatchObject({
      kind: "route",
      params: { docId: "a.html" },
      route: { kind: "docTrust", auth: "cookie+csrf" },
    });
    expect(matchRoute("POST", "/api/doc/a.html/normalize")).toMatchObject({
      kind: "route",
      params: { docId: "a.html" },
      route: { kind: "docNormalize", auth: "cookie+csrf" },
    });
  });

  it("should freeze the table at 20 entries (12 + 5 + info + trust/normalize)", () => {
    expect(ROUTES).toHaveLength(20);
    expect(matchRoute("GET", "/api/doc/a.html/info")).toMatchObject({
      kind: "route",
      params: { docId: "a.html" },
      route: { kind: "docInfo", auth: "cookie" },
    });
  });

  it("should not let an annotation id span a slash", () => {
    expect(matchRoute("POST", "/api/doc/a.html/annotations/an-1a2b/x/resolve").kind).toBe("none");
    expect(matchRoute("GET", "/api/doc/a.html/notes/an-1a2b/x/diff").kind).toBe("none");
  });
});

describe("matchRoute · 方法不允许与全不匹配", () => {
  it("should report the allowed methods when the path matches but the method does not", () => {
    expect(matchRoute("GET", "/api/patch")).toEqual({ kind: "method", allowed: ["POST"] });
    expect(matchRoute("POST", "/healthz")).toEqual({ kind: "method", allowed: ["GET"] });
    expect(matchRoute("DELETE", "/s/x.html")).toEqual({ kind: "method", allowed: ["GET"] });
  });

  it.each([
    ["/nope"],
    ["//"],
    ["/healthz/"],
    ["/s//x.html"],
    ["/s"],
    ["healthz"],
    ["/api/doc/a.html/model/x"],
  ])("should return none for %s", (path) => {
    expect(matchRoute("GET", path)).toEqual({ kind: "none" });
  });
});

describe("decodeParams · 先解码再判", () => {
  it("should decode percent escapes", () => {
    expect(decodeParams({ docId: "a%20b.html" })).toEqual({
      ok: true,
      params: { docId: "a b.html" },
    });
    expect(decodeParams({ docId: "..%2Fx.html" })).toEqual({
      ok: true,
      params: { docId: "../x.html" },
    });
  });

  it("should reject a malformed escape", () => {
    expect(decodeParams({ docId: "%zz" })).toEqual({ ok: false });
    expect(decodeParams({ docId: "%" })).toEqual({ ok: false });
  });

  it("should return a frozen empty record when there are no params", () => {
    const decoded = decodeParams({});

    expect(decoded).toEqual({ ok: true, params: {} });
  });
});
