// The static build must fail loudly when the emitted browser bundle keeps Node-only
// code: dist is served verbatim, and a moved version.ts or any stray node: import leaves
// a module the browser cannot run — silently, because the bake step only writes one file.

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const APP_DIR = join(import.meta.dirname, "..");
const SCRIPT = join(APP_DIR, "scripts", "build-static.mjs");

/** What tsc emits for src/version.ts: a node:fs import plus an import.meta file read. */
const TSC_VERSION_EMIT = [
  'import { readFileSync } from "node:fs";',
  'export const APP_VERSION = readFileSync(new URL("../package.json", import.meta.url), "utf8");',
].join("\n");

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface Sandbox {
  readonly run: () => { readonly status: number | null; readonly output: string };
  readonly versionJs: () => string;
}

/** A throwaway package layout the real script runs against verbatim (script dir → app dir). */
const sandboxOf = (distFiles: Readonly<Record<string, string>>): Sandbox => {
  const dir = mkdtempSync(join(tmpdir(), "hr-build-guard-"));
  dirs.push(dir);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "static"), { recursive: true });
  cpSync(SCRIPT, join(dir, "scripts", "build-static.mjs"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "9.9.9" }));
  writeFileSync(join(dir, "static", "index.html"), "<html></html>");
  writeFileSync(join(dir, "static", "styles.css"), "body{}");
  for (const [name, body] of Object.entries(distFiles)) {
    const target = join(dir, "dist", "assets", name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  return {
    run: () => {
      const result = spawnSync(process.execPath, [join(dir, "scripts", "build-static.mjs")], {
        cwd: dir,
        encoding: "utf8",
      });
      return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
    },
    versionJs: () => readFileSync(join(dir, "dist", "assets", "version.js"), "utf8"),
  };
};

describe("build-static · emitted bundle audit", () => {
  it("should bake the package version into version.js when the emit is well formed", () => {
    const sandbox = sandboxOf({
      "version.js": TSC_VERSION_EMIT,
      "main.js": "export const main = 1;",
    });
    const { status, output } = sandbox.run();
    expect(output.trim()).toBe("");
    expect(status).toBe(0);
    const baked = sandbox.versionJs();
    expect(baked).toContain('APP_VERSION = "v9.9.9"');
    expect(baked).not.toContain("node:");
    expect(baked).not.toContain("import.meta");
  });

  it("should fail when tsc did not emit version.js at the expected path", () => {
    const sandbox = sandboxOf({ "internal/version.js": TSC_VERSION_EMIT });
    const { status, output } = sandbox.run();
    expect(status).toBe(1);
    expect(output).toContain("version.js");
  });

  it("should fail when any emitted module keeps a node: builtin import", () => {
    const sandbox = sandboxOf({
      "version.js": TSC_VERSION_EMIT,
      "extra.js": 'import { join } from "node:path";\nexport const j = join;',
    });
    const { status, output } = sandbox.run();
    expect(status).toBe(1);
    expect(output).toContain("extra.js");
  });

  it("should fail when any emitted module resolves files via import.meta.url", () => {
    const sandbox = sandboxOf({
      "version.js": TSC_VERSION_EMIT,
      "meta.js": "export const here = import.meta.url;",
    });
    const { status, output } = sandbox.run();
    expect(status).toBe(1);
    expect(output).toContain("meta.js");
  });

  it("should not fail on bare specifiers that are not Node builtins", () => {
    const sandbox = sandboxOf({
      "version.js": TSC_VERSION_EMIT,
      "extra.js": 'import { helper } from "some-npm-package";\nexport const h = helper;',
    });
    const { status, output } = sandbox.run();
    expect(output.trim()).toBe("");
    expect(status).toBe(0);
  });
});

// Builtins imported without the "node:" prefix and the import.meta filesystem/globals
// surface reach the browser exactly like the node: forms — same ban, same audit.
const AUDIT_REJECTS: readonly { readonly name: string; readonly body: string }[] = [
  {
    name: 'a bare builtin import (from "fs")',
    body: 'import { open } from "fs";\nexport const o = open;',
  },
  {
    name: 'a bare builtin subpath (from "fs/promises")',
    body: 'import { readFile } from "fs/promises";\nexport const r = readFile;',
  },
  {
    name: 'a bare side-effect builtin (import "path")',
    body: 'import "path";\nexport const p = 1;',
  },
  {
    name: 'a bare dynamic builtin (import("os"))',
    body: 'export const o = () => import("os");',
  },
  {
    name: 'a bare builtin require (require("child_process"))',
    body: 'const cp = require("child_process");\nmodule.exports = cp;',
  },
  {
    name: "import.meta.dirname",
    body: "export const d = import.meta.dirname;",
  },
  {
    name: "import.meta.filename",
    body: "export const f = import.meta.filename;",
  },
  {
    name: "import.meta.resolve",
    body: 'export const r = import.meta.resolve("x");',
  },
  {
    name: "Node globals via globalThis (globalThis.process)",
    body: "export const e = globalThis.process.env.HOME;",
  },
  {
    name: "Node globals via globalThis (globalThis.Buffer)",
    body: "export const b = globalThis.Buffer;",
  },
  {
    name: "Node globals via globalThis (globalThis.require)",
    body: 'export const r = globalThis.require("fs");',
  },
  {
    name: 'Node globals via globalThis computed access (globalThis["process"])',
    body: 'export const e = globalThis["process"].env;',
  },
  {
    name: "Node globals via globalThis computed access with inner spaces (globalThis[ 'Buffer' ])",
    body: "export const b = globalThis[ 'Buffer' ];",
  },
  {
    name: "Node globals via globalThis computed access with a template literal (globalThis[`require`])",
    body: "export const r = globalThis[`require`];",
  },
  {
    name: 'Node globals via globalThis computed access with outer spaces (globalThis [ "process" ])',
    body: 'export const e = globalThis [ "process" ].env;',
  },
];

for (const { name, body } of AUDIT_REJECTS) {
  describe(`build-static · emitted bundle audit rejects ${name}`, () => {
    it("should fail", () => {
      const sandbox = sandboxOf({ "version.js": TSC_VERSION_EMIT, "extra.js": body });
      const { status, output } = sandbox.run();
      expect(status).toBe(1);
      expect(output).toContain("extra.js");
    });
  });
}

// The audit bans only the Node-global names through globalThis. Browser globals reached the
// same way stay legal emits — console (log.ts logs through it) and document (allowed outside
// the pure layer, whose eslint ban is file-scoped) — and a bare "globalThis" mention in
// unrelated text is not an access at all.
const AUDIT_ALLOWS: readonly { readonly name: string; readonly body: string }[] = [
  {
    name: 'globalThis["console"]',
    body: 'export const c = globalThis["console"].error;',
  },
  {
    name: 'globalThis["document"]',
    body: 'export const d = globalThis["document"].title;',
  },
  {
    name: 'a bare "globalThis" string literal',
    body: 'export const s = "globalThis";',
  },
];

for (const { name, body } of AUDIT_ALLOWS) {
  describe(`build-static · emitted bundle audit allows ${name}`, () => {
    it("should not fail", () => {
      const sandbox = sandboxOf({ "version.js": TSC_VERSION_EMIT, "extra.js": body });
      const { status, output } = sandbox.run();
      expect(output.trim()).toBe("");
      expect(status).toBe(0);
    });
  });
}
