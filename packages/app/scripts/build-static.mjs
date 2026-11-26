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

const FORBIDDEN = [
  { label: 'ESM builtin import (from "node:…")', re: /\bfrom\s*["']node:/ },
  { label: 'bare builtin import (import "node:…")', re: /\bimport\s*["']node:/ },
  { label: 'dynamic builtin import (import("node:…"))', re: /\bimport\s*\(\s*["']node:/ },
  { label: 'CJS builtin require (require("node:…"))', re: /\brequire\s*\(\s*["']node:/ },
  { label: "import.meta file resolution (import.meta.url)", re: /\bimport\.meta\.url\b/ },
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
