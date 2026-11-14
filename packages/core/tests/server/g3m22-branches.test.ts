// 这层管：M2.2 新增的顶层分支——`/api/theme` 清单路由（精确段）与 content-type 兜底。

import { describe, expect, it } from "vitest";

import { contentTypeOf } from "../../src/server/http-io";
import { matchRoute } from "../../src/server/routes";

describe("matchRoute · 清单路由（M2.2 裁定 #2）", () => {
  it("should match /api/theme as the themes route with no params", () => {
    expect(matchRoute("GET", "/api/theme")).toMatchObject({
      kind: "route",
      params: {},
      route: { kind: "themes", auth: "none", method: "GET" },
    });
  });

  it("should still refuse a path that is shorter than every route", () => {
    expect(matchRoute("GET", "/api")).toEqual({ kind: "none" });
  });

  it("should refuse a trailing-slash variant instead of treating it as the themes route", () => {
    expect(matchRoute("GET", "/api/theme/")).toEqual({ kind: "none" });
  });
});

describe("contentTypeOf · 未知扩展名", () => {
  it("should fall back to application/octet-stream", () => {
    expect(contentTypeOf("/app/assets/font.woff2")).toBe("application/octet-stream");
    expect(contentTypeOf("/app/assets/README")).toBe("application/octet-stream");
  });
});
