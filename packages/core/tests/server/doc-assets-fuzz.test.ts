// Property tests for the /f/ scope verdict (fast-check): for arbitrary decoded
// path input, `docAssetReply` must (a) never throw, (b) answer only 200/404,
// (c) never read a byte outside the granted directory. The reads are recorded
// through the FileSystem port, so a served-body-without-reads bug would also
// trip the secret-canary assertion.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";

import { isInside } from "../../src/io/paths";
import { nodePatchDeps } from "../../src/io/node-fs";
import type { ResolvedTarget } from "../../src/io/paths";
import { nodeStyleDeps } from "../../src/style";
import { createCapabilityBook, type DirGrant } from "../../src/server/capability";
import { docAssetReply } from "../../src/server/doc-assets";
import type { HandlerContext } from "../../src/server/handlers";

const SECRET = "TOP-SECRET-CANARY\n";
const PAGE = "<!doctype html><html><body><h1>page</h1></body></html>";

interface Fixture {
  readonly ctx: HandlerContext;
  readonly grant: DirGrant;
  /** A second registered document in the same directory — its own cap. */
  readonly sibling: DirGrant;
  readonly workspace: string;
  readonly home: string;
  /** Every path the FileSystem port was asked to read. */
  readonly reads: string[];
}

const dirs: string[] = [];

const fixtureOf = (): Fixture => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "hr-fuzz-ws-")));
  const home = realpathSync(mkdtempSync(join(tmpdir(), "hr-fuzz-home-")));
  dirs.push(workspace, home);
  const page = join(workspace, "page");
  mkdirSync(join(page, "sub", "deep"), { recursive: true });
  writeFileSync(join(page, "index.html"), PAGE);
  writeFileSync(join(page, "other.html"), PAGE);
  writeFileSync(join(page, "style.css"), "/* marker:style */\n");
  writeFileSync(join(page, "sub", "deep", "app.js"), "console.info(1);\n");
  writeFileSync(join(page, ".hidden.txt"), "hidden\n");
  // The canary lives outside the granted directory: reachable only on a breach.
  writeFileSync(join(workspace, "secret.txt"), SECRET);

  const caps = createCapabilityBook();
  const target: ResolvedTarget = {
    realPath: join(page, "index.html"),
    relative: "page/index.html",
    workspace,
    storeDir: join(workspace, ".hreader"),
    lockPath: join(workspace, ".hreader", "locks", "x.lock"),
  };
  const grant = caps.register(target);
  const sibling = caps.register({
    realPath: join(page, "other.html"),
    relative: "page/other.html",
    workspace,
    storeDir: join(workspace, ".hreader"),
    lockPath: join(workspace, ".hreader", "locks", "x.lock"),
  });
  const reads: string[] = [];
  const deps = {
    ...nodePatchDeps,
    fs: {
      ...nodePatchDeps.fs,
      readFile: async (path: string) => {
        reads.push(path);
        return nodePatchDeps.fs.readFile(path);
      },
    },
  };
  const ctx: HandlerContext = {
    workspace,
    appDir: "",
    home,
    deps,
    styleDeps: nodeStyleDeps(workspace),
    caps,
  };
  return { ctx, grant, sibling, workspace, home, reads };
};

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Grammar-hostile segments, over-weighted toward the vectors that matter. */
const segmentArb = fc.oneof(
  fc.string({ maxLength: 40 }),
  fc.string({ minLength: 200, maxLength: 300 }),
  fc.constant(".."),
  fc.constant("."),
  fc.constant(".hreader"),
  fc.constant(".hidden.txt"),
  fc.constant("..."),
  fc.constant("...."),
  fc.constant("%2e%2e"),
  fc.constant("%2f"),
  fc.constant("%00"),
  fc.constant("\\"),
  fc.constant("sub"),
  fc.constant("deep"),
  fc.constant("index.html"),
  fc.constant("style.css"),
  fc.constant("app.js"),
  fc.constant("secret.txt"),
);

const pathArb = fc.oneof(
  fc.array(segmentArb, { minLength: 0, maxLength: 8 }).map((parts) => parts.join("/")),
  fc.string({ maxLength: 600 }),
  fc.string({ minLength: 500, maxLength: 700 }),
);

const nearCapArb = (cap: string) =>
  fc.oneof(
    fc.string({ maxLength: 64 }),
    fc.constant(cap),
    fc.constant(cap.slice(0, -1)),
    fc.constant(`${cap}x`),
    fc.constant(cap.toLowerCase()),
    fc.constant(cap.slice(1)),
    fc.constant(`${cap.slice(0, -1)}${cap.endsWith("A") ? "B" : "A"}`),
  );

describe("/f/ scope verdict (property)", () => {
  it("should never serve a byte outside the granted directory, for arbitrary paths", async () => {
    const { ctx, grant, workspace, reads } = fixtureOf();
    await fc.assert(
      fc.asyncProperty(pathArb, async (rawPath) => {
        reads.length = 0;
        const reply = await docAssetReply(ctx, grant.cap, rawPath);
        // The route is total: arbitrary input only ever yields 200 or the
        // indistinguishable 404. A throw or other status fails the property.
        expect([200, 404]).toContain(reply.status);
        // Every workspace-resident read must land inside the granted dir.
        // (reads in `home` are the permission lookups of the doc exception —
        // outside the workspace and therefore filtered out here.)
        for (const path of reads.filter((path) => path.startsWith(workspace))) {
          expect(isInside(grant.dir, path), `read escaped: ${path}`).toBe(true);
        }
        if (reply.status === 200) {
          expect(String(reply.body)).not.toContain(SECRET);
        }
      }),
      { numRuns: 400, seed: 20240601 },
    );
  });

  it("should accept exactly the registered cap and nothing else, for arbitrary caps", async () => {
    const { ctx, grant } = fixtureOf();
    await fc.assert(
      fc.asyncProperty(nearCapArb(grant.cap), async (cap) => {
        const reply = await docAssetReply(ctx, cap, "style.css");
        expect([200, 404]).toContain(reply.status);
        // Bidirectional: the one true cap serves, everything else is 404.
        // There is no approximate, prefix, or case-folded match.
        if (cap === grant.cap) {
          expect(reply.status).toBe(200);
        } else {
          expect(reply.status).toBe(404);
          expect(reply.body).toBe('{"code":"not_found"}');
        }
      }),
      { numRuns: 200, seed: 20240602 },
    );
  });

  it("should serve each registered HTML only under its own cap", async () => {
    const { ctx, grant, sibling } = fixtureOf();
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.constant("index.html"),
          fc.constant("other.html"),
          fc.constant("INDEX.HTML"),
          fc.constant("index.HTML"),
          fc.constant("./index.html"),
          fc.constant("sub/index.html"),
          fc.constant("index.html/"),
          fc.constant("index.htm"),
          fc.string({ maxLength: 60 }),
        ),
        async (rawPath) => {
          // Both documents were opened and share one directory — but a cap is
          // bound to a document. A sibling's basename under this cap is just
          // another non-whitelist name: the HTML exception never crosses.
          const reply = await docAssetReply(ctx, grant.cap, rawPath);
          expect([200, 404]).toContain(reply.status);
          if (String(reply.headers["content-type"]).includes("text/html")) {
            expect(rawPath).toBe("index.html");
          }
          const sibReply = await docAssetReply(ctx, sibling.cap, rawPath);
          expect([200, 404]).toContain(sibReply.status);
          if (String(sibReply.headers["content-type"]).includes("text/html")) {
            expect(rawPath).toBe("other.html");
          }
        },
      ),
      { numRuns: 100, seed: 20240603 },
    );
  });
});
