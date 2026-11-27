// This layer owns: copying `static/` (index.html + styles.css) into `dist/` — tsc only
// handles .ts. The daemon serves `dist/` statically: `/` → index.html, `/assets/*` →
// dist/assets/*.
//
// It also rewrites the tsc-emitted `dist/assets/version.js` into a baked literal:
// `src/version.ts` reads `package.json` on the Node side (vitest / typecheck), but the
// browser has no `node:fs`, so the version is baked into the artifact at build time —
// `package.json` stays the single source of truth.
//
// After the rewrite the whole dist tree is audited: the bundle must not keep Node
// builtins or import.meta file reads. tsc emits whatever src does — a moved
// src/version.ts leaves a real node:fs emit behind — so we verify instead of
// trusting the layout.

import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = dirname(here);
const out = join(app, "dist", "assets");
const dist = join(app, "dist");

const fail = (message) => {
  process.stderr.write(`build-static: ${message}\n`);
  process.exit(1);
};

await mkdir(out, { recursive: true });
await copyFile(join(app, "static", "index.html"), join(app, "dist", "index.html"));
await copyFile(join(app, "static", "styles.css"), join(out, "styles.css"));
// The annotate-mode stub: served by the daemon as `/f/<cap>/__hr_annotator.js`,
// so it must sit next to index.html — not under assets/.
await copyFile(join(app, "static", "annotator.js"), join(dist, "annotator.js"));

// tsc must have emitted src/version.ts at exactly this path; a moved or renamed source
// would leave this file missing (and the stray Node-side emit somewhere else in dist).
const VERSION_EMIT = join(out, "version.js");
if (!existsSync(VERSION_EMIT)) {
  fail(`tsc did not emit ${VERSION_EMIT} — src/version.ts must compile to that path`);
}

const { version } = JSON.parse(await readFile(join(app, "package.json"), "utf8"));
await writeFile(
  VERSION_EMIT,
  `// Baked at build time from package.json; see src/version.ts.\nexport const APP_VERSION = ${JSON.stringify(`v${version}`)};\n`,
);

// Unprefixed builtin specifiers (from "fs", import "path", require("os")) are the same
// unrunnable-in-the-browser import as the node: forms — ban the whole builtinModules list,
// not only the prefix. builtinModules also carries node:* aliases; the dedicated node:
// patterns above already cover those.
const BARE_BUILTINS = builtinModules.filter((name) => !name.startsWith("node:"));
const BUILTIN_GROUP = BARE_BUILTINS.join("|");

// Same list as eslint's no-restricted-properties for packages/app/src: the Node globals that
// must never be reached through globalThis. Member access (globalThis.<name>) and computed
// access (globalThis["<name>"]) share this one list so the two forms cannot drift apart.
const NODE_GLOBAL_GROUP = [
  "process",
  "Buffer",
  "__dirname",
  "__filename",
  "global",
  "require",
  "module",
  "exports",
  "setImmediate",
  "clearImmediate",
].join("|");

const FORBIDDEN = [
  { label: 'ESM builtin import (from "node:…")', re: /\bfrom\s*["']node:/ },
  { label: 'bare builtin import (import "node:…")', re: /\bimport\s*["']node:/ },
  { label: 'dynamic builtin import (import("node:…"))', re: /\bimport\s*\(\s*["']node:/ },
  { label: 'CJS builtin require (require("node:…"))', re: /\brequire\s*\(\s*["']node:/ },
  {
    label: 'ESM builtin import without prefix (from "<builtin>")',
    re: new RegExp(`\\bfrom\\s*["'](?:${BUILTIN_GROUP})["']`),
  },
  {
    label: 'bare builtin import without prefix (import "<builtin>")',
    re: new RegExp(`\\bimport\\s*["'](?:${BUILTIN_GROUP})["']`),
  },
  {
    label: 'dynamic builtin import without prefix (import("<builtin>"))',
    re: new RegExp(`\\bimport\\s*\\(\\s*["'](?:${BUILTIN_GROUP})["']`),
  },
  {
    label: 'CJS builtin require without prefix (require("<builtin>"))',
    re: new RegExp(`\\brequire\\s*\\(\\s*["'](?:${BUILTIN_GROUP})["']`),
  },
  { label: "import.meta file resolution (import.meta.url)", re: /\bimport\.meta\.url\b/ },
  {
    label: "import.meta filesystem paths (import.meta.dirname/filename)",
    re: /\bimport\.meta\.(dirname|filename)\b/,
  },
  {
    label: "import.meta module resolution (import.meta.resolve)",
    re: /\bimport\.meta\.resolve\b/,
  },
  {
    // Reached through globalThis, a banned global carries no bare restricted identifier, so
    // it dodges the source-level globals ban. Both access forms are audited: member access
    // (globalThis.<name>) and computed access — globalThis["<name>"], single/double quotes or
    // a template literal, optional whitespace around the brackets.
    label: 'Node globals via globalThis (globalThis.<node global> or globalThis["<node global>"])',
    re: new RegExp(
      `\\bglobalThis\\s*(?:\\.\\s*(?:${NODE_GLOBAL_GROUP})\\b|\\[\\s*["'\`](?:${NODE_GLOBAL_GROUP})["'\`]\\s*\\])`,
    ),
  },
];

const jsFilesOf = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return jsFilesOf(path);
      return entry.name.endsWith(".js") ? [path] : [];
    }),
  );
  return nested.flat();
};

const violations = [];
for (const file of await jsFilesOf(dist)) {
  const body = await readFile(file, "utf8");
  for (const { label, re } of FORBIDDEN) {
    if (re.test(body)) violations.push(`${relative(app, file)}: ${label}`);
  }
}
if (violations.length > 0) {
  fail(
    `emitted bundle keeps Node-only code the browser cannot run:\n${violations
      .map((line) => `  - ${line}`)
      .join("\n")}`,
  );
}
