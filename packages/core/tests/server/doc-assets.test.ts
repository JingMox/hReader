// Wire tests for `GET /f/<cap>/<path>`: capability auth, scope verdict, typed
// asset replies, and the Origin:null regression battery. The adversarial
// vectors here are point cases; the "arbitrary path never escapes" proof lives
// in doc-assets-fuzz.test.ts.

import { mkdirSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { nodePatchDeps } from "../../src/io/node-fs";
import type { ResolvedTarget } from "../../src/io/paths";
import { nodeStyleDeps } from "../../src/style";
import { createCapabilityBook } from "../../src/server/capability";
import { docAssetReply, MAX_DOC_ASSET_BYTES } from "../../src/server/doc-assets";
import type { HandlerContext } from "../../src/server/handlers";
import { cookieOf, defaultSeed, docPageOf, httpCall, withServer } from "./harness";

const PAGE_HTML = "<!doctype html><html><body><h1>page</h1></body></html>";
const CSS = "body { color: red; }\n";
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';

const seed = (workspace: string): void => {
  defaultSeed(workspace);
  const page = join(workspace, "page");
  mkdirSync(join(page, "sub"), { recursive: true });
  writeFileSync(join(page, "index.html"), PAGE_HTML);
  writeFileSync(join(page, "style.css"), CSS);
  writeFileSync(join(page, "sub", "app.js"), "console.info(1);\n");
  writeFileSync(join(page, "data.json"), '{"ok":true}\n');
  writeFileSync(join(page, "other.html"), "<!doctype html><p>other</p>");
  writeFileSync(join(page, ".hidden.txt"), "hidden\n");
  writeFileSync(join(page, "data.xml"), "<x/>\n");
  writeFileSync(join(page, "payload.exe"), "MZ\n");
  writeFileSync(join(page, "noext"), "x\n");
  writeFileSync(join(page, "pic.svg"), SVG);
  // Traversal bait: a file that is only reachable if `..` slips through.
  writeFileSync(join(workspace, "secret.txt"), "TOP SECRET\n");
  // Symlinks covering every verdict branch.
  symlinkSync("style.css", join(page, "alias.css"));
  symlinkSync(join("..", "secret.txt"), join(page, "escape.css"));
  symlinkSync("/etc/hosts", join(page, "outside.css"));
  symlinkSync("loop.css", join(page, "loop.css"));
  symlinkSync("other.html", join(page, "mask.css"));
  symlinkSync(".hidden.txt", join(page, "dot.css"));
  // A directory wearing an asset name: grammar and whitelist pass, lstat says no.
  mkdirSync(join(page, "dirlink.css"));
  // A second doc directory, for the cross-directory cap battery.
  const other = join(workspace, "page2");
  mkdirSync(other);
  writeFileSync(join(other, "only-in-b.css"), "/* b */\n");
  writeFileSync(join(other, "index.html"), PAGE_HTML);
};

/** `/s/<docId>` 302s; the `location` is the /f/ frame URL this suite pokes at. */
const frameUrlOf = async (port: number, token: string, docId: string): Promise<string> => {
  const entry = await httpCall(port, {
    path: `/s/${encodeURIComponent(docId)}`,
    headers: { cookie: cookieOf(token) },
  });
  const location = entry.headers["location"];
  expect(entry.status).toBe(302);
  expect(typeof location).toBe("string");
  return location as string;
};

const capOf = (frameUrl: string): string => frameUrl.split("/")[2] ?? "";

describe("GET /f/<cap>/<path>", () => {
  it("should redirect /s/<docId> into a capability frame URL", () =>
    withServer(async ({ port, token }) => {
      const entry = await httpCall(port, {
        path: `/s/${encodeURIComponent("page/index.html")}`,
        headers: { cookie: cookieOf(token) },
      });
      expect(entry.status).toBe(302);
      expect(entry.headers["location"]).toMatch(/^\/f\/[A-Za-z0-9_-]{22}\/index\.html$/u);
      expect(entry.headers["cache-control"]).toContain("no-store");
    }, seed));

  it("should serve the document itself with permission-matrix headers", () =>
    withServer(async ({ port, token }) => {
      const page = await docPageOf(port, token, "page/index.html");
      expect(page.status).toBe(200);
      expect(page.headers["content-type"]).toContain("text/html");
      expect(page.headers["content-security-policy"]).toContain("sandbox");
      expect(page.headers["x-content-type-options"]).toBe("nosniff");
      expect(page.headers["access-control-allow-origin"]).toBe("null");
      expect(page.headers["referrer-policy"]).toBe("no-referrer");
      expect(page.body).toContain("<h1>page</h1>");
    }, seed));

  it("should serve whitelisted assets including subdirectories", () =>
    withServer(async ({ port, token }) => {
      const frame = await frameUrlOf(port, token, "page/index.html");
      const base = frame.slice(0, frame.lastIndexOf("/"));
      const css = await httpCall(port, { path: `${base}/style.css` });
      expect(css.status).toBe(200);
      expect(css.headers["content-type"]).toBe("text/css; charset=utf-8");
      expect(css.headers["x-content-type-options"]).toBe("nosniff");
      expect(css.headers["access-control-allow-origin"]).toBe("null");
      expect(css.headers["referrer-policy"]).toBe("no-referrer");
      expect(css.body).toBe(CSS);
      const nested = await httpCall(port, { path: `${base}/sub/app.js` });
      expect(nested.status).toBe(200);
      expect(nested.headers["content-type"]).toBe("text/javascript; charset=utf-8");
      const json = await httpCall(port, { path: `${base}/data.json` });
      expect(json.status).toBe(200);
      expect(json.headers["content-type"]).toBe("application/json; charset=utf-8");
    }, seed));

  it("should set the exact content type of every whitelisted extension", () =>
    withServer(async ({ port, token, workspace }) => {
      // One file per extension: the table is the contract, so every value is
      // pinned verbatim (svg is covered separately because it also carries CSP).
      const cases: readonly (readonly [string, string])[] = [
        ["a.css", "text/css; charset=utf-8"],
        ["a.js", "text/javascript; charset=utf-8"],
        ["a.mjs", "text/javascript; charset=utf-8"],
        ["a.json", "application/json; charset=utf-8"],
        ["a.png", "image/png"],
        ["a.jpg", "image/jpeg"],
        ["a.jpeg", "image/jpeg"],
        ["a.gif", "image/gif"],
        ["a.webp", "image/webp"],
        ["a.avif", "image/avif"],
        ["a.ico", "image/x-icon"],
        ["a.woff", "font/woff"],
        ["a.woff2", "font/woff2"],
        ["a.ttf", "font/ttf"],
        ["a.otf", "font/otf"],
        ["a.mp3", "audio/mpeg"],
        ["a.mp4", "video/mp4"],
        ["a.webm", "video/webm"],
        ["a.ogg", "audio/ogg"],
        ["a.wav", "audio/wav"],
        ["a.m4a", "audio/mp4"],
        ["a.wasm", "application/wasm"],
        ["a.txt", "text/plain; charset=utf-8"],
      ];
      for (const [name] of cases) writeFileSync(join(workspace, "page", name), "x");
      const frame = await frameUrlOf(port, token, "page/index.html");
      const base = frame.slice(0, frame.lastIndexOf("/"));
      for (const [name, type] of cases) {
        const res = await httpCall(port, { path: `${base}/${name}` });
        expect(res.status, name).toBe(200);
        expect(res.headers["content-type"], name).toBe(type);
        expect(res.headers["cache-control"], name).toBe("no-store");
        // The inert-document CSP is an svg-only header.
        expect(res.headers["content-security-policy"], name).toBeUndefined();
      }
    }, seed));

  it("should answer SVG with the inert-document CSP", () =>
    withServer(async ({ port, token }) => {
      const frame = await frameUrlOf(port, token, "page/index.html");
      const base = frame.slice(0, frame.lastIndexOf("/"));
      const svg = await httpCall(port, { path: `${base}/pic.svg` });
      expect(svg.status).toBe(200);
      expect(svg.headers["content-type"]).toBe("image/svg+xml");
      expect(svg.headers["content-security-policy"]).toBe(
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      );
    }, seed));

  it("should not serve any other HTML than the registered document", () =>
    withServer(async ({ port, token }) => {
      const frame = await frameUrlOf(port, token, "page/index.html");
      const base = frame.slice(0, frame.lastIndexOf("/"));
      // Same directory, different document: .html is not an asset type.
      for (const probe of ["other.html", "index.HTML", "INDEX.HTML", "style.css/x.html"]) {
        const res = await httpCall(port, { path: `${base}/${probe}` });
        expect(res.status, probe).toBe(404);
        expect(res.body).toContain("not_found");
      }
    }, seed));

  it("should hide dotfiles, .hreader/ and non-whitelist extensions", () =>
    withServer(async ({ port, token }) => {
      const frame = await frameUrlOf(port, token, "page/index.html");
      const base = frame.slice(0, frame.lastIndexOf("/"));
      for (const probe of [
        ".hidden.txt",
        ".hreader/x.txt",
        "sub/.git/config",
        "data.xml",
        "payload.exe",
        "noext",
        "index.html.bak",
      ]) {
        const res = await httpCall(port, { path: `${base}/${encodeURI(probe)}` });
        expect(res.status, probe).toBe(404);
      }
    }, seed));

  it("should resolve in-scope symlinks and refuse escaping ones", () =>
    withServer(async ({ port, token }) => {
      const frame = await frameUrlOf(port, token, "page/index.html");
      const base = frame.slice(0, frame.lastIndexOf("/"));
      const alias = await httpCall(port, { path: `${base}/alias.css` });
      expect(alias.status).toBe(200);
      expect(alias.body).toBe(CSS);
      // Escape to workspace root, to the host filesystem, loops, resolved
      // names that fail the grammar/type verdict, and a directory wearing an
      // asset name all collapse to the same 404.
      for (const probe of [
        "escape.css",
        "outside.css",
        "loop.css",
        "mask.css",
        "dot.css",
        "dirlink.css",
      ]) {
        const res = await httpCall(port, { path: `${base}/${probe}` });
        expect(res.status, probe).toBe(404);
        expect(res.body).toBe('{"code":"not_found"}');
      }
    }, seed));

  it("should reject every traversal spelling the router decodes", () =>
    withServer(async ({ port, token }) => {
      const frame = await frameUrlOf(port, token, "page/index.html");
      const base = frame.slice(0, frame.lastIndexOf("/"));
      for (const probe of [
        "../secret.txt",
        "%2e%2e/secret.txt",
        "sub/../../secret.txt",
        "..%2fsecret.txt",
        "%2e%2e%2fsecret.txt",
        "sub/%2e%2e/%2e%2e/secret.txt",
        "%252e%252e/secret.txt",
        "..%5csecret.txt",
        "a%00.txt",
        "%2fetc%2fhosts",
      ]) {
        const res = await httpCall(port, { path: `${base}/${probe}` });
        expect(res.status, probe).toBe(404);
      }
      // Literal `..` is collapsed by the URL parser before routing, so it can
      // only ever name an in-scope resource (or miss the route entirely).
      // `style.css/../index.html` normalizes to `index.html` — the doc itself.
      const normalized = await httpCall(port, { path: `${base}/style.css/../index.html` });
      expect(normalized.status).toBe(200);
      expect(String(normalized.headers["content-type"])).toContain("text/html");
      // Overlong path and overlong segment are rejected before any IO.
      const longPath = `${"a".repeat(600)}.css`;
      expect((await httpCall(port, { path: `${base}/${longPath}` })).status).toBe(404);
      const longSegment = `${"a".repeat(300)}.css`;
      expect((await httpCall(port, { path: `${base}/${longSegment}` })).status).toBe(404);
    }, seed));

  it("should accept paths and segments exactly at the grammar limits", () =>
    withServer(async ({ port, token, workspace }) => {
      // Boundary pins: 512 total chars and a 255-char segment are allowed.
      mkdirSync(join(workspace, "page", "a".repeat(250), "b".repeat(255)), {
        recursive: true,
      });
      writeFileSync(join(workspace, "page", "a".repeat(250), "b".repeat(255), "f.css"), CSS);
      const longestName = `${"n".repeat(251)}.css`;
      writeFileSync(join(workspace, "page", longestName), CSS);
      const frame = await frameUrlOf(port, token, "page/index.html");
      const base = frame.slice(0, frame.lastIndexOf("/"));
      const deep = `${"a".repeat(250)}/${"b".repeat(255)}/f.css`;
      expect(deep).toHaveLength(512);
      expect((await httpCall(port, { path: `${base}/${deep}` })).status).toBe(200);
      expect(longestName).toHaveLength(255);
      expect((await httpCall(port, { path: `${base}/${longestName}` })).status).toBe(200);
    }, seed));

  it("should refuse files above the single-file ceiling and serve at it", () =>
    withServer(async ({ port, token, workspace }) => {
      // Sparse files: no real disk cost, still honest 50MiB reads.
      const big = join(workspace, "page", "big.txt");
      writeFileSync(big, "");
      truncateSync(big, MAX_DOC_ASSET_BYTES + 1);
      const exact = join(workspace, "page", "exact.txt");
      writeFileSync(exact, "");
      truncateSync(exact, MAX_DOC_ASSET_BYTES);
      const frame = await frameUrlOf(port, token, "page/index.html");
      const base = frame.slice(0, frame.lastIndexOf("/"));
      expect((await httpCall(port, { path: `${base}/big.txt` })).status).toBe(404);
      expect((await httpCall(port, { path: `${base}/exact.txt` })).status).toBe(200);
    }, seed));

  it("should scope every path to the cap's own directory", () =>
    withServer(async ({ port, token }) => {
      const frameA = await frameUrlOf(port, token, "page/index.html");
      const capA = capOf(frameA);
      const baseA = frameA.slice(0, frameA.lastIndexOf("/"));
      // A cap minted for page/ cannot name anything outside page/.
      const cross = await httpCall(port, { path: `${baseA}/only-in-b.css` });
      expect(cross.status).toBe(404);
      // The other directory's cap is a different token entirely.
      const frameB = await frameUrlOf(port, token, "page2/index.html");
      const capB = capOf(frameB);
      expect(capB).not.toBe(capA);
      const stolen = await httpCall(port, {
        path: `/f/${capB}/style.css`,
      });
      expect(stolen.status).toBe(404);
      // ...but a cap does cover its own subdirectories (page/ is inside the
      // root doc's grant): documented scope, locked here.
      const root = await frameUrlOf(port, token, "doc.html");
      const capRoot = capOf(root);
      const nested = await httpCall(port, { path: `/f/${capRoot}/page/style.css` });
      expect(nested.status).toBe(200);
      const secret = await httpCall(port, { path: `/f/${capRoot}/secret.txt` });
      expect(secret.status).toBe(200);
    }, seed));

  it("should serve each HTML only under its own document capability", () =>
    withServer(async ({ port, token }) => {
      // A and B share page/ and were both opened: each cap covers the
      // directory's whitelisted assets, but the HTML exception is bound to
      // the document the cap was minted for — the other registered HTML is
      // indistinguishable from any non-whitelist name under A's cap.
      const frameA = await frameUrlOf(port, token, "page/index.html");
      const frameB = await frameUrlOf(port, token, "page/other.html");
      const capA = capOf(frameA);
      const capB = capOf(frameB);
      expect(capB).not.toBe(capA);
      const baseA = frameA.slice(0, frameA.lastIndexOf("/"));
      const cross = await httpCall(port, { path: `${baseA}/other.html` });
      expect(cross.status).toBe(404);
      const indexUnderB = await httpCall(port, { path: `/f/${capB}/index.html` });
      expect(indexUnderB.status).toBe(404);
      // Each cap still serves its own document and the directory's assets.
      for (const path of [frameA, frameB, `${baseA}/style.css`, `/f/${capB}/style.css`]) {
        expect((await httpCall(port, { path })).status, path).toBe(200);
      }
    }, seed));

  it("should treat the cap as the only credential on this route", () =>
    withServer(async ({ port, token }) => {
      const frame = await frameUrlOf(port, token, "page/index.html");
      const base = frame.slice(0, frame.lastIndexOf("/"));
      // No cookie at all.
      expect((await httpCall(port, { path: `${base}/style.css` })).status).toBe(200);
      // A wrong cookie does not help or hurt a valid cap.
      const badCookie = await httpCall(port, {
        path: `${base}/style.css`,
        headers: { cookie: "hr=forged" },
      });
      expect(badCookie.status).toBe(200);
      // A good cookie does not rescue a forged cap.
      const badCap = await httpCall(port, {
        path: `/f/${"A".repeat(22)}/style.css`,
        headers: { cookie: cookieOf(token) },
      });
      expect(badCap.status).toBe(404);
      // Truncated and cross-directory caps are forged caps.
      const cap = capOf(frame);
      expect((await httpCall(port, { path: `/f/${cap.slice(0, 21)}/style.css` })).status).toBe(404);
    }, seed));

  it("should tolerate Origin:null on /f/ but nowhere else", () =>
    withServer(async ({ port, token }) => {
      const frame = await frameUrlOf(port, token, "page/index.html");
      const base = frame.slice(0, frame.lastIndexOf("/"));
      for (const origin of ["null", "NULL", "  Null  "]) {
        const res = await httpCall(port, {
          path: `${base}/style.css`,
          headers: { origin },
        });
        expect(res.status, `origin=${origin}`).toBe(200);
        expect(res.headers["access-control-allow-origin"]).toBe("null");
      }
      // Every other route still rejects Origin:null outright.
      for (const path of [
        "/s/doc.html",
        "/api/permissions",
        "/api/doc/doc.html/info",
        "/assets/app.js",
        "/healthz",
        "/nope",
      ]) {
        const res = await httpCall(port, { path, headers: { origin: "null" } });
        expect(res.status, path).toBe(403);
        expect(res.body).toContain("forbidden_origin");
      }
      // A non-null foreign origin is rejected on /f/ too: the tolerance is
      // exactly the literal "null", not "any origin on this route".
      const foreign = await httpCall(port, {
        path: `${base}/style.css`,
        headers: { origin: "https://evil.example" },
      });
      expect(foreign.status).toBe(403);
      // And the Host gate still applies.
      const badHost = await httpCall(port, {
        path: `${base}/style.css`,
        headers: { host: "evil.example" },
      });
      expect(badHost.status).toBe(403);
    }, seed));

  it("should keep every failure indistinguishable and CORS-stamped", () =>
    withServer(async ({ port, token }) => {
      const frame = await frameUrlOf(port, token, "page/index.html");
      const base = frame.slice(0, frame.lastIndexOf("/"));
      const bodies = new Set<string>();
      // Every probe below reaches docAssetReply (literal and %2e spellings of
      // `..` are normalized by the URL parser into a non-route 404 — covered in
      // the traversal battery — so the ACAO stamp is asserted on-handler only;
      // %2e%2e%2f survives upstream normalization via its encoded slash).
      for (const path of [
        `${base}/missing.css`,
        `${base}/%2e%2e%2fsecret.txt`,
        `${base}/data.xml`,
        `${base}/.hidden.txt`,
        `/f/${"B".repeat(22)}/style.css`,
      ]) {
        const res = await httpCall(port, { path });
        expect(res.status, path).toBe(404);
        expect(res.headers["access-control-allow-origin"], path).toBe("null");
        expect(res.headers["x-content-type-options"], path).toBe("nosniff");
        expect(res.headers["content-type"], path).toBe("application/json; charset=utf-8");
        bodies.add(res.body);
      }
      expect(bodies.size).toBe(1);
    }, seed));

  it("should refuse non-GET methods on the capability route", () =>
    withServer(async ({ port, token }) => {
      const frame = await frameUrlOf(port, token, "page/index.html");
      const base = frame.slice(0, frame.lastIndexOf("/"));
      const res = await httpCall(port, { method: "POST", path: `${base}/style.css` });
      expect(res.status).toBe(405);
    }, seed));
});

describe("docAssetReply · late-IO failures (direct calls)", () => {
  // These branches are TOCTOU windows — realpath/lstat/readFile disagreeing —
  // unreachable without steering the FileSystem port (same seam static-app uses).
  const PAGE = join(tmpdir(), "hr-da-unit");
  const FILE_STAT = { isFile: () => true, isSymbolicLink: () => false, mtimeMs: 0, size: 2 };
  // A FileSystem that would happily serve anything handed to it: used to prove
  // the verdict is lexical — a grammar miss can never reach the serving arms.
  const SERVING_FS = {
    realpath: () => Promise.resolve(join(PAGE, "ok.css")),
    lstat: () => Promise.resolve(FILE_STAT),
    readFile: () => Promise.resolve(new TextEncoder().encode("ok")),
  };
  const ctxWith = (
    fs: Partial<typeof nodePatchDeps.fs>,
  ): { readonly ctx: HandlerContext; readonly cap: string } => {
    const caps = createCapabilityBook();
    const target: ResolvedTarget = {
      realPath: join(PAGE, "index.html"),
      relative: "page/index.html",
      workspace: tmpdir(),
      storeDir: join(tmpdir(), ".hreader"),
      lockPath: join(tmpdir(), ".hreader", "locks", "x.lock"),
    };
    const grant = caps.register(target);
    const ctx: HandlerContext = {
      workspace: tmpdir(),
      appDir: "",
      home: tmpdir(),
      deps: { ...nodePatchDeps, fs: { ...nodePatchDeps.fs, ...fs } },
      styleDeps: nodeStyleDeps(tmpdir()),
      caps,
    };
    return { ctx, cap: grant.cap };
  };

  it("should 404 when lstat loses the race after realpath", async () => {
    const { ctx, cap } = ctxWith({
      realpath: (path) => Promise.resolve(path),
      lstat: () => Promise.reject(new Error("ENOENT between realpath and lstat")),
    });
    const reply = await docAssetReply(ctx, cap, "x.css");
    expect(reply.status).toBe(404);
    expect(reply.body).toBe('{"code":"not_found"}');
  });

  it("should 404 when readFile loses the race after lstat", async () => {
    const { ctx, cap } = ctxWith({
      realpath: (path) => Promise.resolve(path),
      lstat: () =>
        Promise.resolve({
          isFile: () => true,
          isSymbolicLink: () => false,
          mtimeMs: 0,
          size: 2,
        }),
      readFile: () => Promise.reject(new Error("EACCES between lstat and readFile")),
    });
    const reply = await docAssetReply(ctx, cap, "x.css");
    expect(reply.status).toBe(404);
  });

  it("should 404 a body above the byte ceiling without a real disk", async () => {
    const { ctx, cap } = ctxWith({
      realpath: (path) => Promise.resolve(path),
      lstat: () =>
        Promise.resolve({
          isFile: () => true,
          isSymbolicLink: () => false,
          mtimeMs: 0,
          size: 2,
        }),
      readFile: () => Promise.resolve(new Uint8Array(MAX_DOC_ASSET_BYTES + 1)),
    });
    const reply = await docAssetReply(ctx, cap, "x.css");
    expect(reply.status).toBe(404);
  });

  it("should reject an oversized file on stat.size without reading a byte", async () => {
    let reads = 0;
    const { ctx, cap } = ctxWith({
      ...SERVING_FS,
      lstat: () => Promise.resolve({ ...FILE_STAT, size: MAX_DOC_ASSET_BYTES + 1 }),
      readFile: () => {
        reads += 1;
        return Promise.resolve(new Uint8Array(0));
      },
    });
    expect((await docAssetReply(ctx, cap, "x.css")).status).toBe(404);
    // The precheck must happen before readFile: an over-ceiling file never
    // lands in memory.
    expect(reads).toBe(0);
  });

  it("should serve a body exactly at the byte ceiling", async () => {
    const { ctx, cap } = ctxWith({
      ...SERVING_FS,
      readFile: () => Promise.resolve(new Uint8Array(MAX_DOC_ASSET_BYTES)),
    });
    expect((await docAssetReply(ctx, cap, "x.css")).status).toBe(200);
  });

  it("should 404 every grammar violation even when IO would succeed", async () => {
    const { ctx, cap } = ctxWith(SERVING_FS);
    // Each probe trips a different arm of the verdict; if that arm ever
    // weakened, the steered FileSystem would hand back a 200.
    for (const probe of [
      "a\0b.css",
      "a\\b.css",
      "a//b.css",
      "a/../x.css",
      `${"n".repeat(256)}.css`,
      `${"a".repeat(250)}/${"b".repeat(255)}/longer.css`,
      "x.xyz",
      ".hidden.css",
    ]) {
      expect((await docAssetReply(ctx, cap, probe)).status, probe).toBe(404);
    }
  });

  it("should 404 when the resolved name fails the grammar a request could not", async () => {
    // A symlink can land on a dot-bearing name the raw path could never spell.
    const { ctx, cap } = ctxWith({
      ...SERVING_FS,
      realpath: () => Promise.resolve(join(PAGE, "a", ".h", "b.css")),
    });
    expect((await docAssetReply(ctx, cap, "link.css")).status).toBe(404);
  });

  it("should 404 when the resolved path is not a regular file", async () => {
    const { ctx, cap } = ctxWith({
      ...SERVING_FS,
      lstat: () =>
        Promise.resolve({
          isFile: () => false,
          isSymbolicLink: () => false,
          mtimeMs: 0,
          size: 0,
        }),
    });
    expect((await docAssetReply(ctx, cap, "x.css")).status).toBe(404);
  });
});
