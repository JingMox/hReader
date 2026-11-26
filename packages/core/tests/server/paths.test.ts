// 这层管：docId 的路径逃逸面——四种编码都要落到 403/404，且**目标文件不得被创建**。

import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { cookieOf, httpCall, withServer } from "./harness";

const OUTSIDE = "secret.html";

const jsonCodeOf = (body: string): unknown => {
  const parsed: unknown = JSON.parse(body);
  return typeof parsed === "object" && parsed !== null && "code" in parsed
    ? parsed.code
    : undefined;
};

describe("paths · 编码逃逸", () => {
  it.each([
    ["..%2Fsecret.html", "path_outside_workspace"],
    ["%2E%2E%2Fsecret.html", "path_outside_workspace"],
    ["..%2F..%2Fsecret.html", "path_outside_workspace"],
    ["%2Fetc%2Fpasswd", "path_outside_workspace"],
  ])("should reject %s with %s and create nothing outside", async (docId, code) => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        path: `/api/doc/${docId}/model`,
        headers: { cookie: cookieOf(ctx.token) },
      });

      expect(response.status).toBe(403);
      expect(jsonCodeOf(response.body)).toBe(code);
      expect(existsSync(join(ctx.workspace, "..", OUTSIDE))).toBe(false);
    });
  });

  it("should keep a double-encoded traversal literal inside the workspace (404, no escape)", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        path: "/api/doc/%252e%252e%252fsecret.html/model",
        headers: { cookie: cookieOf(ctx.token) },
      });

      expect(response.status).toBe(404);
      expect(jsonCodeOf(response.body)).toBe("not_a_file");
    });
  });
});

describe("paths · 编码逃逸（续）", () => {
  it("should treat a backslash as a normal name char (POSIX), not an escape (404)", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        path: "/api/doc/..%5Csecret.html/model",
        headers: { cookie: cookieOf(ctx.token) },
      });

      expect(response.status).toBe(404);
      expect(existsSync(join(ctx.workspace, "..", OUTSIDE))).toBe(false);
    });
  });

  it("should reject a full-width slash name without escaping (404)", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        path: "/api/doc/%2E%2E%EF%BC%8Fsecret.html/model",
        headers: { cookie: cookieOf(ctx.token) },
      });

      expect(response.status).toBe(404);
    });
  });

  it("should reject a NUL byte as invalid_request (400)", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        path: "/api/doc/a%00b.html/model",
        headers: { cookie: cookieOf(ctx.token) },
      });

      expect(response.status).toBe(400);
      expect(jsonCodeOf(response.body)).toBe("invalid_request");
    });
  });
});

describe("paths · 编码逃逸（续）（续）", () => {
  it("should reject an 8 KiB name without touching the disk", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        path: `/api/doc/${"a".repeat(8192)}.html/model`,
        headers: { cookie: cookieOf(ctx.token) },
      });

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(existsSync(join(ctx.workspace, "..", OUTSIDE))).toBe(false);
    });
  });

  it("should answer not_a_file (404) for a name over the fs segment limit", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        path: `/api/doc/${"a".repeat(300)}.html/model`,
        headers: { cookie: cookieOf(ctx.token) },
      });

      expect(response.status).toBe(404);
      expect(jsonCodeOf(response.body)).toBe("not_a_file");
    });
  });
});
