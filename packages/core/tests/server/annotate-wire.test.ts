// This layer owns the annotate-mode wire surface: auth and mint shape of
// `POST /api/doc/<docId>/annotate`, the inject/fallback semantics of
// `/f/<cap>/<doc>?annotate=<token>`, and the `__hr_annotator.js` reserved
// name. The failure side of a token burn has exactly one observable shape:
// plain document, original CSP, no nonce.

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { nodePatchDeps } from "../../src/io/node-fs";
import { startServer } from "../../src/server/server";
import { nodeStyleDeps } from "../../src/style";
import { fixedClock } from "../io/harness";
import {
  cookieOf,
  defaultSeed,
  httpCall,
  jsonBodyOf,
  withServer,
  type HttpResponse,
  type TestServer,
} from "./harness";
import { withPost } from "./wire";

const FOREIGN =
  '<!doctype html><html><body><div class="app"><script>window.x=1</script>外来</div></body></html>';
const FOREIGN_OTHER = "<!doctype html><html><body><p>other doc</p></body></html>";

const OFF_CSP =
  "default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self'; media-src 'self'; " +
  "frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox";

const foreignSeed = (workspace: string): void => {
  defaultSeed(workspace);
  writeFileSync(join(workspace, "doc.html"), FOREIGN, "utf8");
  writeFileSync(join(workspace, "other.html"), FOREIGN_OTHER, "utf8");
  writeFileSync(join(workspace, "app.js"), "console.info(1);\n", "utf8");
};

const postAnnotate = async (
  ctx: TestServer,
  docId = "doc.html",
  headers: Readonly<Record<string, string>> = withPost(ctx.token),
): Promise<HttpResponse> =>
  httpCall(ctx.port, {
    method: "POST",
    path: `/api/doc/${docId}/annotate`,
    headers,
    body: "{}",
  });

const frameUrlOf = async (ctx: TestServer, docId = "doc.html"): Promise<string> => {
  const response = await postAnnotate(ctx, docId);
  expect(response.status).toBe(200);
  const body = jsonBodyOf(response) as { frameUrl: string };
  return body.frameUrl;
};

/** Frame URL shape (frozen contract): `/f/<cap-22>/<doc>?annotate=<token-22>`. */
const FRAME_URL = /^\/f\/[A-Za-z0-9_-]{22}\/[^/?]+\?annotate=[A-Za-z0-9_-]{22}$/u;

const nonceOf = (response: HttpResponse): string | undefined =>
  /nonce="([A-Za-z0-9_-]{22})"/u.exec(response.body)?.[1];

const annotatorTagIn = (body: string): string | undefined =>
  /<script nonce="[^"]+" src="\/f\/[^/]+\/__hr_annotator\.js" defer><\/script>/u.exec(body)?.[0];

describe("annotate route · auth", () => {
  it("should answer 401 without a cookie", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/doc/doc.html/annotate",
        headers: { "x-hr-csrf": "1", "content-type": "application/json" },
        body: "{}",
      });

      expect(response.status).toBe(401);
      expect(response.body).toContain("unauthorized");
    }, foreignSeed);
  });

  it("should answer 403 without the CSRF header", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/doc/doc.html/annotate",
        headers: { cookie: cookieOf(ctx.token), "content-type": "application/json" },
        body: "{}",
      });

      expect(response.status).toBe(403);
      expect(response.body).toContain("forbidden_origin");
    }, foreignSeed);
  });

  it("should answer 403 for Origin: null — the null exception is /f/-only", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/doc/doc.html/annotate",
        headers: { ...withPost(ctx.token), origin: "null" },
        body: "{}",
      });

      expect(response.status).toBe(403);
    }, foreignSeed);
  });

  it("should refuse a non-foreign document with needs_normalize (409)", async () => {
    await withServer(async (ctx) => {
      // defaultSeed's doc.html is managed (hr-meta + node ids): annotating it
      // would mean nothing — it never renders in the foreign iframe.
      const response = await postAnnotate(ctx, "doc.html");

      expect(response.status).toBe(409);
      expect(response.body).toContain("needs_normalize");
    }, defaultSeed);
  });

  it("should return 400 when body.docId disagrees with the path", async () => {
    await withServer(async (ctx) => {
      const response = await httpCall(ctx.port, {
        method: "POST",
        path: "/api/doc/doc.html/annotate",
        headers: withPost(ctx.token),
        body: JSON.stringify({ docId: "other.html" }),
      });

      expect(response.status).toBe(400);
      expect(response.body).toContain("invalid_payload");
    }, foreignSeed);
  });
});

describe("annotate route · mint", () => {
  it("should return a frameUrl with a fresh 22-char token", async () => {
    await withServer(async (ctx) => {
      const response = await postAnnotate(ctx);

      expect(response.status).toBe(200);
      const body = jsonBodyOf(response) as { frameUrl: string };
      expect(body.frameUrl).toMatch(FRAME_URL);
    }, foreignSeed);
  });

  it("should mint a different token per call", async () => {
    await withServer(async (ctx) => {
      expect(await frameUrlOf(ctx)).not.toBe(await frameUrlOf(ctx));
    }, foreignSeed);
  });
});

describe("annotate serve · token verdicts", () => {
  it("should inject the annotator tag and the annotate CSP on a valid token", async () => {
    await withServer(async (ctx) => {
      const frameUrl = await frameUrlOf(ctx);
      const response = await httpCall(ctx.port, { path: frameUrl });

      expect(response.status).toBe(200);
      const tag = annotatorTagIn(response.body);
      expect(tag).toBeDefined();
      // Injected immediately after the doctype — before any page markup.
      expect(response.body.indexOf(tag ?? "")).toBeLessThan(response.body.indexOf("<html"));
      const nonce = nonceOf(response);
      expect(nonce).toBeDefined();
      const csp = String(response.headers["content-security-policy"] ?? "");
      expect(csp).toBe(
        OFF_CSP.replace("script-src 'none'", `script-src 'nonce-${nonce ?? ""}'`).replace(
          "; sandbox",
          "; sandbox allow-scripts",
        ),
      );
      expect(csp).not.toContain("allow-same-origin");
      // The file on disk is untouched — the injection is a response transform.
      expect(readFileSync(ctx.file, "utf8")).not.toContain("nonce=");
    }, foreignSeed);
  });

  it("should serve the plain document on a reused token — no oracle, no nonce", async () => {
    await withServer(async (ctx) => {
      const frameUrl = await frameUrlOf(ctx);
      const first = await httpCall(ctx.port, { path: frameUrl });
      const second = await httpCall(ctx.port, { path: frameUrl });

      expect(annotatorTagIn(first.body)).toBeDefined();
      expect(second.status).toBe(200);
      expect(second.body).toBe(FOREIGN);
      expect(second.headers["content-security-policy"]).toBe(OFF_CSP);
      expect(second.body).not.toContain("nonce=");
    }, foreignSeed);
  });

  it("should serve the plain document on a forged token", async () => {
    await withServer(async (ctx) => {
      const cap = /\/f\/([A-Za-z0-9_-]{22})\//u.exec(await frameUrlOf(ctx))?.[1];
      const response = await httpCall(ctx.port, {
        path: `/f/${cap ?? ""}/doc.html?annotate=${"x".repeat(22)}`,
      });

      expect(response.status).toBe(200);
      expect(response.body).toBe(FOREIGN);
      expect(response.body).not.toContain("nonce=");
    }, foreignSeed);
  });

  it("should serve the plain document on a cross-document token", async () => {
    await withServer(async (ctx) => {
      const token = /annotate=([A-Za-z0-9_-]{22})/u.exec(await frameUrlOf(ctx))?.[1];
      // /s/ 302 is the reliable way to learn the second doc's cap.
      const entry = await httpCall(ctx.port, {
        path: "/s/other.html",
        headers: { cookie: cookieOf(ctx.token) },
      });
      const cap = /\/f\/([A-Za-z0-9_-]{22})\//u.exec(String(entry.headers["location"] ?? ""))?.[1];
      const response = await httpCall(ctx.port, {
        path: `/f/${cap ?? ""}/other.html?annotate=${token ?? ""}`,
      });

      expect(response.status).toBe(200);
      expect(response.body).toBe(FOREIGN_OTHER);
      expect(response.body).not.toContain("nonce=");
    }, foreignSeed);
  });

  it("should ignore annotate on non-document asset paths entirely", async () => {
    await withServer(async (ctx) => {
      const frameUrl = await frameUrlOf(ctx);
      const cap = /\/f\/([A-Za-z0-9_-]{22})\//u.exec(frameUrl)?.[1];
      const token = /annotate=([A-Za-z0-9_-]{22})/u.exec(frameUrl)?.[1];
      const response = await httpCall(ctx.port, {
        path: `/f/${cap ?? ""}/app.js?annotate=${token ?? ""}`,
      });

      expect(response.status).toBe(200);
      expect(response.body).toBe("console.info(1);\n");
      expect(response.headers["content-security-policy"]).toBeUndefined();
      // A real token spent on an asset path must stay unburned — it is ignored, not consumed.
      const frame = await httpCall(ctx.port, { path: frameUrl });
      expect(annotatorTagIn(frame.body)).toBeDefined();
    }, foreignSeed);
  });

  it("should serve the plain document on an expired token (fake clock)", async () => {
    const { clock, advance } = fixedClock(1_000_000);
    await withServer(
      async (ctx) => {
        const frameUrl = await frameUrlOf(ctx);
        // The serve-time clock is 60 s of real time; advancing past the TTL
        // kills the token before the iframe navigation happens.
        advance(61_000);
        const response = await httpCall(ctx.port, { path: frameUrl });

        expect(response.status).toBe(200);
        expect(response.body).toBe(FOREIGN);
        expect(response.body).not.toContain("nonce=");
      },
      foreignSeed,
      { patch: { ...nodePatchDeps, clock } },
    );
  });

  it("should differ in nonce between two annotate loads", async () => {
    await withServer(async (ctx) => {
      const first = await httpCall(ctx.port, { path: await frameUrlOf(ctx) });
      const second = await httpCall(ctx.port, { path: await frameUrlOf(ctx) });

      expect(nonceOf(first)).toBeDefined();
      expect(nonceOf(second)).toBeDefined();
      expect(nonceOf(first)).not.toBe(nonceOf(second));
    }, foreignSeed);
  });

  it("should pass annotate uncritically on a managed document", async () => {
    await withServer(async (ctx) => {
      // defaultSeed's doc.html is managed — a `?annotate=` parameter on its
      // /f/ URL must not change the response (the early managed return never
      // reads it).
      const entry = await httpCall(ctx.port, {
        path: "/s/doc.html",
        headers: { cookie: cookieOf(ctx.token) },
      });
      const location = String(entry.headers["location"] ?? "");
      const [plain, annotated] = await Promise.all([
        httpCall(ctx.port, { path: location }),
        httpCall(ctx.port, { path: `${location}?annotate=${"x".repeat(22)}` }),
      ]);

      expect(annotated.status).toBe(200);
      expect(annotated.body).toBe(plain.body);
      expect(annotated.body).not.toContain("nonce=");
    }, defaultSeed);
  });
});

describe("annotator asset · reserved name", () => {
  const withApp = async (
    appFiles: Readonly<Record<string, string>>,
    run: (ctx: TestServer) => Promise<void>,
  ): Promise<void> => {
    const appDir = realpathSync(mkdtempSync(join(tmpdir(), "hr-annotate-app-")));
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "hr-annotate-ws-")));
    const home = realpathSync(mkdtempSync(join(tmpdir(), "hr-annotate-home-")));
    try {
      foreignSeed(workspace);
      for (const [name, body] of Object.entries(appFiles)) {
        writeFileSync(join(appDir, name), body, "utf8");
      }
      const server = await startServer(
        { workspace, port: 0, home, docId: "doc.html", appDir },
        { patch: nodePatchDeps, style: nodeStyleDeps(workspace), now: Date.now },
      );
      try {
        await run({
          server,
          workspace,
          home,
          port: server.port,
          token: server.token,
          docId: "doc.html",
          file: join(workspace, "doc.html"),
          close: async () => {
            await server.close();
          },
        });
      } finally {
        await server.close();
      }
    } finally {
      rmSync(appDir, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  };

  it("should serve <appDir>/annotator.js with nosniff + no-store headers", async () => {
    await withApp({ "annotator.js": "/* marker:real annotator */\n" }, async (ctx) => {
      const frameUrl = await frameUrlOf(ctx);
      const cap = /\/f\/([A-Za-z0-9_-]{22})\//u.exec(frameUrl)?.[1];
      const response = await httpCall(ctx.port, { path: `/f/${cap ?? ""}/__hr_annotator.js` });

      expect(response.status).toBe(200);
      expect(response.body).toContain("marker:real annotator");
      expect(response.headers["content-type"]).toBe("text/javascript; charset=utf-8");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["access-control-allow-origin"]).toBe("null");
    });
  });

  it("should shadow a same-named file inside the document directory", async () => {
    await withApp({ "annotator.js": "/* marker:real annotator */\n" }, async (ctx) => {
      writeFileSync(join(ctx.workspace, "__hr_annotator.js"), "/* marker:planted evil */\n");
      const frameUrl = await frameUrlOf(ctx);
      const cap = /\/f\/([A-Za-z0-9_-]{22})\//u.exec(frameUrl)?.[1];
      const response = await httpCall(ctx.port, { path: `/f/${cap ?? ""}/__hr_annotator.js` });

      expect(response.status).toBe(200);
      expect(response.body).toContain("marker:real annotator");
      expect(response.body).not.toContain("planted evil");
    });
  });

  it("should 404 like every other /f/ miss when the file is absent", async () => {
    await withApp({}, async (ctx) => {
      const frameUrl = await frameUrlOf(ctx);
      const cap = /\/f\/([A-Za-z0-9_-]{22})\//u.exec(frameUrl)?.[1];
      const response = await httpCall(ctx.port, { path: `/f/${cap ?? ""}/__hr_annotator.js` });

      expect(response.status).toBe(404);
      expect(response.body).toBe('{"code":"not_found"}');
    });
  });

  it("should 404 for a bad cap even on the reserved name", async () => {
    await withApp({ "annotator.js": "x\n" }, async (ctx) => {
      const response = await httpCall(ctx.port, {
        path: `/f/${"z".repeat(22)}/__hr_annotator.js`,
      });

      expect(response.status).toBe(404);
    });
  });
});
