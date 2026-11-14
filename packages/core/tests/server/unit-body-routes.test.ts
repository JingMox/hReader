// 这层管：`src/server/body.ts` 与 `routes.ts` 的纯函数（JSON 取字段 / 路由匹配 / 参数解码）。

import { describe, expect, it } from "vitest";

import { codeOf } from "../io/harness";
import {
  integerFieldOf,
  jsonBodyOf,
  MAX_BODY_BYTES,
  numberFieldOf,
  requiredStringOf,
  stringFieldOf,
} from "../../src/server/body";
import { decodeParams, matchRoute, ROUTES } from "../../src/server/routes";

describe("jsonBodyOf · 只接受对象", () => {
  it("should accept a JSON object", () => {
    expect(jsonBodyOf('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });

  it.each([["[]"], ["null"], ["1"], ['"x"'], ["{"], ["{}x"]])(
    "should reject %j as invalid",
    (text) => {
      expect(jsonBodyOf(text)).toEqual({ ok: false });
    },
  );
});

describe("字段取值 · 缺/错类型", () => {
  const record = { s: "x", n: 2, i: 3, bad: 1.5, nan: Number.NaN, inf: Number.POSITIVE_INFINITY };

  it("should return strings and finite numbers only", () => {
    expect(stringFieldOf(record, "s")).toBe("x");
    expect(stringFieldOf(record, "n")).toBeUndefined();
    expect(numberFieldOf(record, "n")).toBe(2);
    expect(numberFieldOf(record, "nan")).toBeUndefined();
    expect(numberFieldOf(record, "inf")).toBeUndefined();
    expect(stringFieldOf(record, "missing")).toBeUndefined();
  });

  it("should return integers and reject everything else with invalid_request", () => {
    expect(integerFieldOf(record, "i")).toBe(3);
    expect(codeOf(() => integerFieldOf(record, "bad"))).toBe("invalid_request");
    expect(codeOf(() => integerFieldOf(record, "missing"))).toBe("invalid_request");
  });

  it("should treat an empty required string as missing", () => {
    expect(requiredStringOf(record, "s")).toBe("x");
    expect(codeOf(() => requiredStringOf({ s: "" }, "s"))).toBe("invalid_request");
    expect(codeOf(() => requiredStringOf(record, "missing"))).toBe("invalid_request");
  });

  it("should pin the 1 MiB body limit", () => {
    expect(MAX_BODY_BYTES).toBe(1_048_576);
  });
});

describe("matchRoute · 精确分段匹配", () => {
  it("should match the GET routes of the frozen table", () => {
    expect(matchRoute("GET", "/").kind).toBe("route");
    expect(matchRoute("get", "/healthz").kind).toBe("route");
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
    // M2.2 新增的两条静态入口：/assets/<任意深度路径> 与内置主题的 CSS。
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

describe("matchRoute · M2.3 的批注与撤销", () => {
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

  it("should freeze the table at 17 entries (12 + 5)", () => {
    expect(ROUTES).toHaveLength(17);
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
