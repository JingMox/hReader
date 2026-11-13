// 这层管：handler 的全部成功/失败分支（经真 HTTP 打进来）——每个错误码都对状态码 + 文件未变。

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { cookieOf, httpCall, withServer } from "./harness";
import { withPost } from "./wire";

const post = async (
  port: number,
  token: string,
  path: string,
  body: unknown,
): Promise<{ readonly status: number; readonly body: string }> => {
  const response = await httpCall(port, {
    method: "POST",
    path,
    headers: withPost(token),
    body: JSON.stringify(body),
  });
  return { status: response.status, body: response.body };
};

const get = async (port: number, token: string, path: string): Promise<number> => {
  const response = await httpCall(port, { path, headers: { cookie: cookieOf(token) } });
  return response.status;
};

describe("handlers · 读路径", () => {
  it("should serve model with revision and model tree", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        path: "/api/doc/doc.html/model",
        headers: { cookie: cookieOf(ctx.token) },
      });
      expect(response.status).toBe(200);
      expect(response.body).toContain('"tag":"article"');
      expect(response.body).toContain('"tag":"h2"');
      expect(response.body).toMatch(/"revision":"[0-9a-f]{16}"/u);
    });
  });

  it("should serve outline with headings", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        path: "/api/doc/doc.html/outline",
        headers: { cookie: cookieOf(ctx.token) },
      });

      expect(response.status).toBe(200);
      expect(response.body).toContain('"outline"');
      expect(response.body).toContain("标题");
    });
  });

  it("should map a missing document to 404 not_a_file", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        path: "/api/doc/nope.html/model",
        headers: { cookie: cookieOf(ctx.token) },
      });

      expect(response.status).toBe(404);
      expect(JSON.parse(response.body)).toMatchObject({ code: "not_a_file" });
    });
  });
});

describe("handlers · 读路径（续）", () => {
  it("should map an escaping docId to 403 and never create the target", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        path: "/api/doc/..%2Fsecret.html/model",
        headers: { cookie: cookieOf(ctx.token) },
      });
      const hidden = await import("node:fs").then((fs) =>
        fs.existsSync(`${ctx.workspace}/../secret.html`),
      );

      expect(response.status).toBe(403);
      expect(JSON.parse(response.body)).toMatchObject({ code: "path_outside_workspace" });
      expect(hidden).toBe(false);
    });
  });
});

describe("handlers · patch", () => {
  it.each([
    ["replace", "hr-c", '<p data-hr-id="hr-c">换</p>', ">换</p>"],
    ["insert_before", "hr-c", "<p>前</p>", ">前</p>"],
    ["insert_after", "hr-c", "<p>后</p>", ">后</p>"],
    ["append", "hr-a", "<p>子</p>", ">子</p>"],
  ])("should accept %s and report changedNodes", async (action, targetId, fragment, marker) => {
    await withServer(async (ctx) => {
      const response = await post(ctx.port, ctx.token, "/api/patch", {
        docId: "doc.html",
        action,
        targetId,
        fragment,
      });
      const html = readFileSync(ctx.file, "utf8");

      expect(response.status).toBe(200);
      expect(response.body).toContain('"changed":true');
      expect(response.body).toMatch(/"changedNodes":\[/u);
      expect(html).toContain(marker);
    });
  });

  it("should accept delete and remove the node", async () => {
    await withServer(async (ctx) => {
      const response = await post(ctx.port, ctx.token, "/api/patch", {
        docId: "doc.html",
        action: "delete",
        targetId: "hr-c",
      });

      expect(response.status).toBe(200);
      expect(readFileSync(ctx.file, "utf8")).not.toContain('data-hr-id="hr-c"');
    });
  });
});

describe("handlers · patch（续）", () => {
  it("should report changed:false for an identical replace without touching history", async () => {
    await withServer(async (ctx) => {
      const before = readFileSync(ctx.file, "utf8");
      const response = await post(ctx.port, ctx.token, "/api/patch", {
        docId: "doc.html",
        action: "replace",
        targetId: "hr-c",
        fragment: '<p data-hr-id="hr-c">正文一</p>',
      });

      expect(response.status).toBe(200);
      expect(response.body).toContain('"changed":false');
      expect(readFileSync(ctx.file, "utf8")).toBe(before);
    });
  });

  it.each([
    [{ docId: "doc.html", action: "explode", targetId: "hr-c" }, "invalid_request", 400],
    [{ docId: "doc.html", action: "append" }, "invalid_request", 400],
    [{ action: "append", targetId: "hr-c" }, "invalid_request", 400],
    [
      { docId: "doc.html", action: "append", targetId: "hr-c", fragment: "<script>x</script>" },
      "forbidden_content",
      400,
    ],
    [{ docId: "doc.html", action: "delete", targetId: "hr-zzz" }, "node_not_found", 404],
  ])("should reject %j with %s", async (body, code, status) => {
    await withServer(async (ctx) => {
      const before = readFileSync(ctx.file, "utf8");
      const response = await post(ctx.port, ctx.token, "/api/patch", body);

      expect(response.status).toBe(status);
      expect(JSON.parse(response.body)).toMatchObject({ code });
      expect(readFileSync(ctx.file, "utf8")).toBe(before);
    });
  });
});

describe("handlers · style 与 annotation", () => {
  it("should apply the builtin theme once, then report changed:false", async () => {
    await withServer(async (ctx) => {
      const first = await post(ctx.port, ctx.token, "/api/style", {
        docId: "doc.html",
        visualId: "atelier-editorial",
      });
      const second = await post(ctx.port, ctx.token, "/api/style", {
        docId: "doc.html",
        visualId: "atelier-editorial",
      });

      expect(first.status).toBe(200);
      expect(first.body).toContain('"changed":true');
      expect(second.body).toContain('"changed":false');
    });
  });

  it("should reject an unknown style with 404", async () => {
    await withServer(async (ctx) => {
      const response = await post(ctx.port, ctx.token, "/api/style", {
        docId: "doc.html",
        visualId: "nope",
      });

      expect(response.status).toBe(404);
      expect(JSON.parse(response.body)).toMatchObject({ code: "unknown_style" });
    });
  });
});

describe("handlers · style 与 annotation（续）", () => {
  it("should append an annotation with 201 and an id", async () => {
    await withServer(async (ctx) => {
      const response = await post(ctx.port, ctx.token, "/api/annotation", {
        docId: "doc.html",
        start: 2,
        end: 4,
        text: "标题",
        note: "n",
      });

      expect(response.status).toBe(201);
      expect(response.body).toMatch(/"id":"an_[0-9a-f]{8}"/u);
      expect(readFileSync(ctx.file, "utf8")).toContain('"annotations":[{"id":"an_');
    });
  });

  it("should reject a bad annotation range with 400 and leave the file alone", async () => {
    await withServer(async (ctx) => {
      const before = readFileSync(ctx.file, "utf8");
      const response = await post(ctx.port, ctx.token, "/api/annotation", {
        docId: "doc.html",
        start: 9,
        end: 1,
        text: "x",
      });

      expect(response.status).toBe(400);
      expect(readFileSync(ctx.file, "utf8")).toBe(before);
    });
  });

  it("should 401 the event stream without a cookie", async () => {
    await withServer(async (ctx) => {
      expect(await get(ctx.port, "", "/api/events")).toBe(401);
    });
  });
});
