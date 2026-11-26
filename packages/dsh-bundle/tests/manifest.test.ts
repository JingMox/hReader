// The package-manifest contract — dsh discovers and writes this package via these fields — plus
// import discipline. Parse results are `unknown`: only `toMatchObject`/`stringMatching` assertions,
// never `as` (this repo bans assertions).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const PKG_DIR = fileURLToPath(new URL("../", import.meta.url));
const SRC_DIR = join(PKG_DIR, "src");

/** Exact version: `1.2.3`, `1.2.3-rc.1`, or `catalog:` (versions converge in pnpm-workspace.yaml's
 *  catalog, the same single source of exact versions); `^`/`~`/`*`/`latest`/`workspace:*` do not match. */
const EXACT_VERSION = /^(?:\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?|catalog:)$/u;

/** The module of a **line-start** import statement is `@deepseek-ai/*` (recognized across lines too; an `import` inside a comment does not count). */
const DEEPSEEK_IMPORT = /^import\s+([\s\S]*?)\s+from\s+["']@deepseek-ai\/[^"']+["']/gmu;

const readText = (path: string): string => readFileSync(path, "utf8");

/** Reads a field by path: parse results are `unknown` (this repo bans `as`), so narrow before asserting. */
const fieldOf = (root: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((node, key) => {
    if (typeof node !== "object" || node === null) return undefined;
    return Object.entries(node).find(([name]) => name === key)?.[1];
  }, root);

const textOf = (root: unknown, ...path: string[]): string => {
  const value = fieldOf(root, ...path);
  if (typeof value !== "string") throw new Error(`期望字符串字段：${path.join(".")}`);
  return value;
};

const manifest: unknown = JSON.parse(readText(join(PKG_DIR, "package.json")));
const patch: unknown = parse(readText(join(PKG_DIR, "cordis.patch.yml")));

const SRC_FILES = readdirSync(SRC_DIR).filter((file) => file.endsWith(".ts"));

describe("package.json", () => {
  it("should match name and private (this package is not published)", () => {
    expect(manifest).toMatchObject({ name: "@hreader/dsh-bundle", private: true });
  });

  it("should let dsh find the patch file via bundle.patch, and that path really exists", () => {
    expect(manifest).toMatchObject({ dsh: { bundle: { patch: "./cordis.patch.yml" } } });
    expect(existsSync(resolve(PKG_DIR, "cordis.patch.yml"))).toBe(true);
  });

  it("should declare compatible versions in dsh.compatibility.dshReleases (dsh blocks the plugin without it)", () => {
    // The expectation is hand-written, not derived from the manifest: it is a literal contract ("compatible from 0.2.2-rc.1+").
    expect(fieldOf(manifest, "dsh", "compatibility", "dshReleases")).toEqual({
      "0.2.2-rc.1+": "compatible",
    });
  });

  it("should pin devDeps to exact versions (no ^ or ~)", () => {
    for (const name of ["@deepseek-ai/cordis", "@deepseek-ai/dsh-system-prompt"]) {
      expect(textOf(manifest, "devDependencies", name)).toMatch(EXACT_VERSION);
    }
  });

  it("should point main/exports/files at the build output, not `.ts` sources (the host installs dist)", () => {
    expect(textOf(manifest, "main")).toBe("./dist/index.js");
    expect(textOf(manifest, "exports", ".", "types")).toBe("./dist/index.d.ts");
    expect(textOf(manifest, "exports", ".", "default")).toBe("./dist/index.js");
    expect(fieldOf(manifest, "files")).toEqual(["dist", "cordis.patch.yml"]);
  });

  it("should not depend on @hreader/core (esbuild bundles it into dist; no workspace protocol inside a profile)", () => {
    expect(fieldOf(manifest, "dependencies")).toBeUndefined();
    expect(textOf(manifest, "devDependencies", "@hreader/core")).toBe("workspace:*");
  });
});

describe("package.json: external deps carry only exact versions", () => {
  it("should make the exact-version regex actually reject range forms (otherwise the previous one is vacuous)", () => {
    for (const ranged of ["^0.2.2-rc.1", "~0.2.2", "*", "latest", "workspace:*"]) {
      expect(ranged).not.toMatch(EXACT_VERSION);
    }
    expect("0.2.2-rc.1").toMatch(EXACT_VERSION);
    expect("4.1.0").toMatch(EXACT_VERSION);
  });
});

describe("cordis.patch.yml", () => {
  it("should carry a single insert whose plugin name comes from package.json and an empty config object", () => {
    expect(patch).toEqual([
      { insert: [{ id: "hreader", name: "@hreader/dsh-bundle", config: {} }] },
    ]);
  });
});

describe("import discipline: the sweep really sweeps something", () => {
  it("should find a nonempty src file set: rename the directory and the two `zero violations` below stay green forever", () => {
    expect(SRC_FILES).toEqual(expect.arrayContaining(["index.ts", "events.ts"]));
  });
});

describe("import discipline", () => {
  it("should hold only `import type` for @deepseek-ai/* in src, with no value import", () => {
    const valueImports = SRC_FILES.flatMap((file) => {
      const text = readText(join(SRC_DIR, file));
      return [...text.matchAll(DEEPSEEK_IMPORT)]
        .filter((match) => !match[1]?.trimStart().startsWith("type "))
        .map((match) => `${file}: ${match[0].replace(/\s+/gu, " ")}`);
    });

    expect(valueImports).toEqual([]);
  });

  it("should take no type binding for @deepseek-ai/* in src (the `import type {}` seed is wiped from the d.ts by tsc)", () => {
    const bound = SRC_FILES.flatMap((file) =>
      [...readText(join(SRC_DIR, file)).matchAll(DEEPSEEK_IMPORT)]
        .filter((match) => !/^import\s+type\s*\{\s*\}/u.test(match[0]))
        .map((match) => `${file}: ${match[0].replace(/\s+/gu, " ")}`),
    );

    expect(bound).toEqual([]);
  });

  it("should make the previous regex actually recognize a value import (otherwise it is vacuous)", () => {
    expect('import { Context } from "@deepseek-ai/cordis";').toMatch(DEEPSEEK_IMPORT);
    expect('import type { PromptSection } from "@deepseek-ai/dsh-system-prompt";').toMatch(
      DEEPSEEK_IMPORT,
    );
    expect('// 注释里提到 import { X } from "@deepseek-ai/cordis" 不算').not.toMatch(
      DEEPSEEK_IMPORT,
    );
  });

  it("should neither require in src nor import from the old 'cordis' name", () => {
    const offenders = SRC_FILES.filter((file) =>
      /require\(|from "cordis"/u.test(readText(join(SRC_DIR, file))),
    );

    expect(offenders).toEqual([]);
  });
});
