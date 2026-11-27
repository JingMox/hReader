// The annotator is a self-contained IIFE injected into foreign frames by the
// server. esbuild bundles src/annotator/ straight to dist/annotator.js — no
// exports, no import.meta, no Node builtins (the dist audit in build-static
// enforces the last two).

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const appDir = dirname(scriptsDir);

await build({
  entryPoints: [join(appDir, "src/annotator/index.ts")],
  outfile: join(appDir, "dist/annotator.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  logLevel: "warning",
});
