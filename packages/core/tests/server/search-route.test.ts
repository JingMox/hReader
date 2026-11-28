// This layer owns the `GET /api/search` route contract: cookie auth (401 without,
// 403 for `Origin: null`), the q/limit validation as 400s, and the wire shape
// (results/total/truncated/diagnostics with workspace-relative paths only).

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { cookieOf, defaultSeed, httpCall, jsonBodyOf, withServer } from "./harness";

interface SearchBody {
  readonly results?: readonly Record<string, unknown>[];
  readonly total?: number;
  readonly truncated?: boolean;
  readonly combine?: string;
  readonly diagnostics?: readonly string[];
  readonly code?: string;
  readonly message?: string;
}

const seedSearch = (workspace: string): void => {
  defaultSeed(workspace);
  writeFileSync(
    join(workspace, "bikes.html"),
    "<!doctype html><html><head><title>维修</title></head><body><p>摩托车 发动机 保养 指南</p></body></html>",
    "utf8",
  );
};

const searchPath = (query: string): string => `/api/search?q=${encodeURIComponent(query)}`;

describe("GET /api/search", () => {
  it("401 without a cookie", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, { path: searchPath("摩托车") });
      expect(response.status).toBe(401);
    }, seedSearch);
  });

  it("403 for `Origin: null` even with a cookie", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        path: searchPath("摩托车"),
        headers: { cookie: cookieOf(ctx.token), origin: "null" },
      });
      expect(response.status).toBe(403);
    }, seedSearch);
  });

  it("200 with the result envelope and workspace-relative paths", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        path: searchPath("摩托车"),
        headers: { cookie: cookieOf(ctx.token) },
      });
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      const body = jsonBodyOf(response) as SearchBody;
      expect(body.results?.[0]?.["path"]).toBe("bikes.html");
      expect(body.results?.[0]?.["kind"]).toBe("doc");
      expect(body.total).toBe(1);
      expect(body.truncated).toBe(false);
      expect(body.combine).toBe("and");
      expect(JSON.stringify(body).includes(ctx.workspace)).toBe(false);
      // The index lock lives under .hreader/locks — the search ran through it.
      expect(existsSync(join(ctx.workspace, ".hreader", "locks"))).toBe(true);
    }, seedSearch);
  });

  it("400 when q is missing, empty, over 200 code points, or limit is malformed", async () => {
    await withServer(async (ctx) => {
      const cookie = cookieOf(ctx.token);
      for (const path of [
        "/api/search",
        "/api/search?q=",
        searchPath("检".repeat(201)),
        "/api/search?q=a&limit=abc",
        "/api/search?q=a&limit=0",
        "/api/search?q=a&limit=101",
        "/api/search?q=a&limit=1.5",
        // Decimal digits only — Number() spellings must all die at the route.
        "/api/search?q=a&limit=1e2",
        "/api/search?q=a&limit=0x10",
        "/api/search?q=a&limit=%205%20",
        "/api/search?q=a&limit=5.0",
      ]) {
        const response = await httpCall(ctx.port, { path, headers: { cookie } });
        const body = jsonBodyOf(response) as SearchBody;
        expect([response.status, body.code], `${path} → ${String(response.status)}`).toEqual([
          400,
          "invalid_request",
        ]);
      }
    }, seedSearch);
  });

  it("400 with the route-level messages for a missing q and a non-integer limit", async () => {
    await withServer(async (ctx) => {
      const cookie = cookieOf(ctx.token);
      const noQ = jsonBodyOf(
        await httpCall(ctx.port, { path: "/api/search", headers: { cookie } }),
      ) as SearchBody;
      expect(noQ.message).toBe("缺少查询参数 q");
      // Non-integer limit is rejected at the route, before core ever sees it.
      for (const limit of ["abc", "1.5"]) {
        const response = await httpCall(ctx.port, {
          path: `/api/search?q=a&limit=${limit}`,
          headers: { cookie },
        });
        const body = jsonBodyOf(response) as SearchBody;
        expect(body.code).toBe("invalid_request");
        expect(body.message).toBe("limit 必须是整数");
      }
      // Core-side messages still reach the wire for its own bounds.
      const empty = jsonBodyOf(
        await httpCall(ctx.port, { path: "/api/search?q=", headers: { cookie } }),
      ) as SearchBody;
      expect(empty.message).toContain("查询词必须是");
      const over = jsonBodyOf(
        await httpCall(ctx.port, { path: "/api/search?q=a&limit=0", headers: { cookie } }),
      ) as SearchBody;
      expect(over.message).toContain("limit 必须是 1..100 的整数");
    }, seedSearch);
  });

  it("accepts the limit bounds 1 and 100", async () => {
    await withServer(async (ctx) => {
      const cookie = cookieOf(ctx.token);
      for (const limit of [1, 100]) {
        const response = await httpCall(ctx.port, {
          path: `/api/search?q=%E6%91%A9%E6%89%98&limit=${String(limit)}`,
          headers: { cookie },
        });
        expect(response.status, `limit=${String(limit)}`).toBe(200);
      }
    }, seedSearch);
  });

  it("limit shapes the result list", async () => {
    await withServer(async (ctx) => {
      const cookie = cookieOf(ctx.token);
      const response = await httpCall(ctx.port, {
        path: "/api/search?q=%E6%91%A9%E6%89%98&limit=1",
        headers: { cookie },
      });
      expect(response.status).toBe(200);
      const body = jsonBodyOf(response) as SearchBody;
      expect(body.results?.length).toBe(1);
    }, seedSearch);
  });
});
