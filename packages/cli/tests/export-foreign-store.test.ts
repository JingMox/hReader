// This layer proves the out-of-workspace no-store contract at the fs boundary:
// `foreignPlanOf` and every gated serve for a doc outside the workspace must
// never let an fs call touch a `.hreader` path — there is no per-document
// store to consult (D39), so "no grant" is a branch decision, not an ENOTDIR
// accident. The only `.hreader` access that survives is the global modes'
// own `<home>/.hreader/permissions.json`.
//
// The recording fs sits under the mocked `nodePatchDeps`: `export-foreign.ts`
// builds its read-only facade from it at module load, so every store access
// the plan or the /f/ serving layer performs passes through the recorder.

import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { FileSystem } from "@hreader/core";

import { foreignPlanOf } from "../src/commands/export-foreign";

const recorded = vi.hoisted((): string[] => []);

vi.mock("@hreader/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hreader/core")>();
  const base = actual.nodePatchDeps.fs;
  const tap =
    <A extends readonly unknown[], R>(verb: string, fn: (...args: A) => R) =>
    (...args: A): R => {
      recorded.push(`${verb} ${String(args[0])}`);
      return fn(...args);
    };
  const fs: FileSystem = {
    readFile: tap("readFile", base.readFile),
    lstat: tap("lstat", base.lstat),
    readdir: tap("readdir", base.readdir),
    realpath: tap("realpath", base.realpath),
    // The read-only facade replaces every write verb before these are ever
    // reached; they delegate anyway so a future direct caller stays honest.
    writeFile: tap("writeFile", base.writeFile),
    writeFileAtomic: tap("writeFileAtomic", base.writeFileAtomic),
    rename: tap("rename", base.rename),
    unlink: tap("unlink", base.unlink),
    mkdir: tap("mkdir", base.mkdir),
    open: tap("open", base.open),
    close: tap("close", base.close),
  };
  return { ...actual, nodePatchDeps: { ...actual.nodePatchDeps, fs } };
});

const DOC = [
  "<!DOCTYPE html><html><head><title>foreign</title></head><body>",
  "<article><h1>One</h1></article><article><h1>Two</h1></article>",
  "</body></html>",
].join("\n");

interface OutsideBox {
  readonly ws: string;
  readonly home: string;
  readonly outside: string;
  readonly doc: string;
}

/** An outside-workspace doc with a decoy store planted beside it: reading or writing it would show up in the recording. */
const outsideBoxOf = (): OutsideBox => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hr-store-")));
  const ws = join(root, "ws");
  const home = join(root, "home");
  const outside = join(root, "outside");
  mkdirSync(ws, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(join(outside, ".hreader"), { recursive: true });
  const doc = join(outside, "index.html");
  writeFileSync(doc, DOC);
  writeFileSync(join(outside, "style.css"), "p { color: red }");
  writeFileSync(
    join(outside, ".hreader", "trust.json"),
    JSON.stringify({ "index.html": { scripts: true, network: true } }),
  );
  return { ws, home, outside, doc };
};

/** The cap segment sits between `/f/` and the doc name. */
const capUrlOf = (plan: { url: string }, path: string): string => {
  const cap = /\/f\/([^/]+)\//.exec(plan.url)?.[1] ?? "";
  return `http://hreader-export.invalid/f/${cap}/${path}`;
};

describe("foreignPlanOf · out-of-workspace documents consult no per-document store", () => {
  it("should make zero fs calls to any .hreader path besides the global modes file", async () => {
    const { ws, home, doc } = outsideBoxOf();
    recorded.length = 0;

    const plan = await foreignPlanOf({ path: doc, workspace: ws, home });
    expect(plan).not.toBeUndefined();
    if (plan === undefined) return;

    // The whole request surface: the doc itself (CSP stamp re-resolves
    // permissions), a sibling asset, and an external fetch verdict.
    const docReply = await plan.gate(plan.url, "GET");
    const assetReply = await plan.gate(capUrlOf(plan, "style.css"), "GET");
    const extReply = await plan.gate("https://cdn.example/x.png", "GET");

    // Behavior is identical to the ENOTDIR-anchored implementation: the doc
    // serves, siblings serve, the decoy grant is ignored, external is denied.
    expect(docReply.kind).toBe("serve");
    if (docReply.kind === "serve") {
      expect(docReply.reply.status).toBe(200);
      expect(String(docReply.reply.headers["content-security-policy"])).not.toContain(
        "allow-scripts",
      );
    }
    expect(assetReply.kind).toBe("serve");
    expect(extReply.kind).toBe("deny");

    // Every `.hreader` fs touch must be exactly the global modes file —
    // the decoy store beside the doc is never even probed.
    const settingsRead = `readFile ${join(home, ".hreader", "permissions.json")}`;
    const touched = recorded.filter((entry) => entry.includes(".hreader"));
    expect(new Set(touched)).toEqual(new Set([settingsRead]));
  });
});
