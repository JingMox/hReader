// This layer covers `foreignPlanOf`'s plan + gate against the filesystem (no
// Chrome): classification, the capability URL, the /f/ serving verdicts shared
// with the server, and the network switch read from effective permissions.
// The real-Chrome behavior lives in `export-foreign-chrome.test.ts`.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { foreignPlanOf } from "../src/commands/export-foreign";
import type { ExportGateAnswer, ForeignPagePlan } from "../src/chrome/types";

const DOC = [
  "<!DOCTYPE html><html><head><title>foreign</title></head><body>",
  "<article><h1>One</h1></article><article><h1>Two</h1></article>",
  "</body></html>",
].join("\n");

const MANAGED =
  '<!doctype html><html><body><article data-hr-id="doc"><h1>m</h1></article></body></html>';
const NORMALIZABLE = "<!doctype html><html><body><article><h1>n</h1></article></body></html>";

interface Sandbox {
  readonly ws: string;
  readonly home: string;
  readonly doc: string;
}

const sandboxOf = (html: string): Sandbox => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hr-gate-")));
  const ws = join(root, "ws");
  const home = join(root, "home");
  mkdirSync(join(ws, "page"), { recursive: true });
  mkdirSync(join(ws, "page", "sub"), { recursive: true });
  mkdirSync(home, { recursive: true });
  const doc = join(ws, "page", "index.html");
  writeFileSync(doc, html);
  writeFileSync(join(ws, "page", "style.css"), "#marker { height: 4400px }");
  writeFileSync(join(ws, "page", "img.png"), Buffer.from([0x89, 0x50]));
  writeFileSync(join(ws, "page", "other.html"), "<p>no</p>");
  writeFileSync(join(ws, "page", "sub", "pic.png"), Buffer.from([0x89]));
  writeFileSync(join(ws, "secret.txt"), "TOP-SECRET");
  return { ws, home, doc };
};

const planOf = async ({ ws, home, doc }: Sandbox): Promise<ForeignPagePlan> => {
  const plan = await foreignPlanOf({ path: doc, workspace: ws, home });
  if (plan === undefined) throw new Error("expected a foreign plan");
  return plan;
};

const serveOf = async (plan: ForeignPagePlan, url: string): Promise<ExportGateAnswer> =>
  plan.gate(url, "GET");

const serveReplyOf = async (plan: ForeignPagePlan, url: string) => {
  const answer = await serveOf(plan, url);
  if (answer.kind !== "serve") throw new Error(`expected serve, got ${answer.kind} for ${url}`);
  return answer.reply;
};

/** The cap segment sits between `/f/` and the doc name. */
const capUrlOf = (plan: ForeignPagePlan, path: string): string => {
  const cap = /\/f\/([^/]+)\//.exec(plan.url)?.[1] ?? "";
  return `http://hreader-export.invalid/f/${cap}/${path}`;
};

const grantOf = (ws: string, grant: { scripts: boolean; network: boolean }): void => {
  mkdirSync(join(ws, ".hreader"), { recursive: true });
  writeFileSync(join(ws, ".hreader", "trust.json"), JSON.stringify({ "page/index.html": grant }));
};

const modesOf = (home: string, modes: { scripts?: string; network?: string }): void => {
  mkdirSync(join(home, ".hreader"), { recursive: true });
  writeFileSync(join(home, ".hreader", "permissions.json"), JSON.stringify(modes));
};

describe("foreignPlanOf · classification", () => {
  it("should produce a plan only for foreign documents", async () => {
    await expect(planOf(sandboxOf(MANAGED))).rejects.toThrow("expected a foreign plan");
    await expect(planOf(sandboxOf(NORMALIZABLE))).rejects.toThrow("expected a foreign plan");
    const plan = await planOf(sandboxOf(DOC));
    expect(plan.url).toMatch(
      /^http:\/\/hreader-export\.invalid\/f\/[A-Za-z0-9_-]{22}\/index\.html$/,
    );
  });

  it("should also plan a doc living outside the workspace (reads are allowed)", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hr-gate-out-")));
    const ws = join(root, "ws");
    const home = join(root, "home");
    const outside = join(root, "outside");
    mkdirSync(ws, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const doc = join(outside, "index.html");
    writeFileSync(doc, DOC);
    writeFileSync(join(outside, "style.css"), "p { color: red }");
    const plan = await foreignPlanOf({ path: doc, workspace: ws, home });
    expect(plan).not.toBeUndefined();
    if (plan === undefined) return;
    // The capability still scopes to the doc's own directory — siblings work.
    const reply = await serveReplyOf(plan, capUrlOf(plan, "style.css"));
    expect(reply.status).toBe(200);
    // And there is no grant store for an outside doc: network stays denied.
    const ext = await serveOf(plan, "https://cdn.example/x.png");
    expect(ext.kind).toBe("deny");
  });

  it("should ignore a trust.json planted next to an outside-workspace doc and never write beside it", async () => {
    // D39: a grant anchors to the exporting workspace's `.hreader/` — an
    // outside doc's own directory is not a store, so a trust.json shipped
    // with the document must be neither read nor written.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hr-gate-out-grant-")));
    const ws = join(root, "ws");
    const home = join(root, "home");
    const outside = join(root, "outside");
    mkdirSync(ws, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(join(outside, ".hreader"), { recursive: true });
    const doc = join(outside, "index.html");
    writeFileSync(doc, DOC);
    const storePath = join(outside, ".hreader", "trust.json");
    // Both grant shapes are planted: the path key (`index.html`) and a legacy
    // sha256 key — the legacy one would even trigger the lazy migration WRITE.
    const planted = JSON.stringify({
      "index.html": { scripts: true, network: true },
      [createHash("sha256").update(DOC, "utf8").digest("hex")]: "local",
    });
    writeFileSync(storePath, planted);

    const plan = await foreignPlanOf({ path: doc, workspace: ws, home });
    if (plan === undefined) throw new Error("expected a foreign plan");

    // The self-shipped grant does not release a single external request,
    // and the document still serves under the strictest CSP (no grant to soften it).
    expect((await serveOf(plan, "https://cdn.example/x.png")).kind).toBe("deny");
    const reply = await serveReplyOf(plan, plan.url);
    expect(reply.status).toBe(200);
    expect(String(reply.headers["content-security-policy"])).not.toContain("allow-scripts");

    // The planted store is untouched: same bytes, nothing new beside it.
    expect(readFileSync(storePath, "utf8")).toBe(planted);
    expect(readdirSync(join(outside, ".hreader")).sort()).toEqual(["trust.json"]);
  });

  it("should apply global modes to an outside-workspace doc and never create .hreader beside it", async () => {
    const outsideOf = (root: string): { ws: string; home: string; outside: string; doc: string } => {
      const ws = join(root, "ws");
      const home = join(root, "home");
      const outside = join(root, "outside");
      mkdirSync(ws, { recursive: true });
      mkdirSync(home, { recursive: true });
      mkdirSync(outside, { recursive: true });
      const doc = join(outside, "index.html");
      writeFileSync(doc, DOC);
      return { ws, home, outside, doc };
    };

    // Global allow-all still governs — the missing per-document grant only
    // means per-doc resolves to off, not that global modes stop applying.
    const allowed = outsideOf(realpathSync(mkdtempSync(join(tmpdir(), "hr-gate-out-mode-"))));
    modesOf(allowed.home, { network: "allow" });
    const allowPlan = await foreignPlanOf({
      path: allowed.doc,
      workspace: allowed.ws,
      home: allowed.home,
    });
    if (allowPlan === undefined) throw new Error("expected a foreign plan");
    expect((await serveOf(allowPlan, "https://cdn.example/x.png")).kind).toBe("allow");
    expect(existsSync(join(allowed.outside, ".hreader"))).toBe(false);

    // Under the default per-doc modes an outside doc has no grant at all —
    // and no .hreader/ materializes beside it even after serving requests.
    const denied = outsideOf(realpathSync(mkdtempSync(join(tmpdir(), "hr-gate-out-mode-"))));
    const denyPlan = await foreignPlanOf({
      path: denied.doc,
      workspace: denied.ws,
      home: denied.home,
    });
    if (denyPlan === undefined) throw new Error("expected a foreign plan");
    expect((await serveReplyOf(denyPlan, denyPlan.url)).status).toBe(200);
    expect((await serveOf(denyPlan, "https://cdn.example/x.png")).kind).toBe("deny");
    expect(existsSync(join(denied.outside, ".hreader"))).toBe(false);
  });
});

describe("export gate · /f/ serving verdicts", () => {
  it("should serve the document itself with the permission-matrix CSP", async () => {
    const plan = await planOf(sandboxOf(DOC));
    const reply = await serveReplyOf(plan, plan.url);
    expect(reply.status).toBe(200);
    expect(reply.headers["content-type"]).toBe("text/html; charset=utf-8");
    const csp = String(reply.headers["content-security-policy"]);
    // scripts off + network off (default deny): the strictest reader CSP.
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("sandbox");
    expect(csp).not.toContain("allow-scripts");
    expect(String(reply.body)).toContain("<article><h1>Two</h1></article>");
  });

  it("should serve sibling assets and subdirectories inside the doc directory", async () => {
    const plan = await planOf(sandboxOf(DOC));
    expect((await serveReplyOf(plan, capUrlOf(plan, "style.css"))).status).toBe(200);
    expect((await serveReplyOf(plan, capUrlOf(plan, "img.png"))).status).toBe(200);
    expect((await serveReplyOf(plan, capUrlOf(plan, "sub/pic.png"))).status).toBe(200);
    expect((await serveReplyOf(plan, capUrlOf(plan, "img.png"))).headers["content-type"]).toBe(
      "image/png",
    );
  });

  it("should refuse every escape shape with the uniform 404", async () => {
    const plan = await planOf(sandboxOf(DOC));
    for (const path of [
      "%2e%2e/secret.txt", // encoded traversal reaches the route
      "../secret.txt", // raw dot segments
      "sub/../../secret.txt", // interior traversal
      ".hreader/trust.json", // dot-leading segment
      "sub/.git/config", // nested dot-leading segment
      "other.html", // extension whitelist: no HTML as a resource
      "missing.png", // absent file
      "style.css/more.css", // directory traversal through a file
      "a\\b.png", // backslash
      "a%00.png", // NUL
      "%2G.png", // invalid percent hex: decodeParams fails on the path
      "sub/%.png", // a lone percent sign: same decode failure deeper in the grammar
    ]) {
      const reply = await serveReplyOf(plan, capUrlOf(plan, path));
      expect(reply.status).toBe(404);
    }
  });

  it("should refuse a foreign cap and every non-/f/ path on the export origin", async () => {
    const plan = await planOf(sandboxOf(DOC));
    for (const url of [
      "http://hreader-export.invalid/f/forged_cap_1234567890/index.html",
      "http://hreader-export.invalid/api/doc/page%2Findex.html/info",
      "http://hreader-export.invalid/healthz",
      "http://hreader-export.invalid/assets/style.css",
      "http://hreader-export.invalid/favicon.ico",
      "http://hreader-export.invalid/",
      "http://hreader-export.invalid",
    ]) {
      const reply = await serveReplyOf(plan, url);
      // The 404 is uniform down to the bytes — headers and body must not leak
      // which failure shape produced it (existence oracle).
      expect(reply.status).toBe(404);
      expect(reply.headers["access-control-allow-origin"]).toBe("null");
      expect(reply.headers["x-content-type-options"]).toBe("nosniff");
      expect(reply.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(reply.body).toBe(JSON.stringify({ code: "not_found" }));
    }
  });
});

describe("export gate · network switch", () => {
  it("should deny every external request when the doc holds no grant", async () => {
    const plan = await planOf(sandboxOf(DOC));
    for (const url of [
      "https://cdn.example/x.png",
      "http://127.0.0.1:1/beacon",
      "ws://127.0.0.1:1/ws",
      "wss://example.com/ws",
    ]) {
      expect((await serveOf(plan, url)).kind).toBe("deny");
    }
  });

  it("should continue external requests only when the effective network permission is on", async () => {
    // doc grant {scripts:false, network:true}
    const granted = sandboxOf(DOC);
    grantOf(granted.ws, { scripts: false, network: true });
    const onPlan = await planOf(granted);
    expect((await serveOf(onPlan, "https://cdn.example/x.png")).kind).toBe("allow");
    expect((await serveOf(onPlan, "http://127.0.0.1:1/beacon")).kind).toBe("allow");
    // Websocket fetches are network traffic too — both members of the socket set.
    expect((await serveOf(onPlan, "ws://127.0.0.1:1/ws")).kind).toBe("allow");
    expect((await serveOf(onPlan, "wss://example.com/ws")).kind).toBe("allow");
    // ...but a granted network never becomes a licence for non-socket schemes:
    // file:/chrome:/javascript: must stay refused even with network on.
    expect((await serveOf(onPlan, "file:///etc/passwd")).kind).toBe("deny");
    expect((await serveOf(onPlan, "chrome://settings")).kind).toBe("deny");

    // global deny overrides the doc grant
    const overridden = sandboxOf(DOC);
    grantOf(overridden.ws, { scripts: false, network: true });
    modesOf(overridden.home, { network: "deny" });
    const offPlan = await planOf(overridden);
    expect((await serveOf(offPlan, "https://cdn.example/x.png")).kind).toBe("deny");

    // global allow overrides a missing doc grant
    const globalOn = sandboxOf(DOC);
    modesOf(globalOn.home, { network: "allow" });
    const allowPlan = await planOf(globalOn);
    expect((await serveOf(allowPlan, "https://cdn.example/x.png")).kind).toBe("allow");
  });

  it("should pass inline schemes through and refuse the rest unconditionally", async () => {
    const plan = await planOf(sandboxOf(DOC));
    for (const url of [
      "data:image/png;base64,iVBOR",
      "blob:http://hreader-export.invalid/uuid",
      "about:blank",
    ]) {
      expect((await serveOf(plan, url)).kind).toBe("allow");
    }
    for (const url of [
      "file:///etc/passwd",
      "file:///tmp/hr-fx/ws/secret.txt",
      "javascript:alert(1)",
      "chrome://settings",
      "ftp://example.com/x",
      "not a url",
    ]) {
      expect((await serveOf(plan, url)).kind).toBe("deny");
    }
  });

  it("should not flip with a scripts grant — the gate only knows the network dimension", async () => {
    // The scripts grant changes the served CSP (allow-scripts), but the export
    // contract still kills JS in the browser — and the gate never consults it.
    const granted = sandboxOf(DOC);
    grantOf(granted.ws, { scripts: true, network: true });
    const plan = await planOf(granted);
    const reply = await serveReplyOf(plan, plan.url);
    // The CSP proves the effective matrix was applied (scripts granted → allow-scripts);
    // the browser-level kill switch is what makes export a snapshot anyway.
    expect(String(reply.headers["content-security-policy"])).toContain("sandbox allow-scripts");
    expect((await serveOf(plan, "https://cdn.example/x.png")).kind).toBe("allow");
  });
});
