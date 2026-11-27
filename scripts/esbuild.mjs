// esbuild bundling conventions shared by the three packages cli / mcp-server / dsh-bundle;
// package-specific steps (tsc, styles, chmod) stay in each package's scripts/build.mjs.
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const TSC = require.resolve("typescript/bin/tsc");

// An ESM artifact has no CJS __filename/__dirname; bundled CJS deps (like write-file-atomic) use
// them — without these defines, the artifact's write path crashes only at runtime.
const COMPAT_DEFINE = {
  __filename: "import.meta.filename",
  __dirname: "import.meta.dirname",
};

// Same reason: CJS deps bundled into an ESM artifact still `require(...)` internally; supply one
// via createRequire.
const REQUIRE_BANNER =
  'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);';
const SHEBANG = "#!/usr/bin/env node";

/**
 * Bundles one node ESM single-file artifact.
 * @param {{ entry: string, outfile: string, shebang?: boolean }} options
 */
export async function bundleNode({ entry, outfile, shebang = false }) {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile,
    sourcemap: true,
    sourcesContent: false,
    logLevel: "warning",
    banner: { js: shebang ? `${SHEBANG}\n${REQUIRE_BANNER}` : REQUIRE_BANNER },
    define: COMPAT_DEFINE,
  });
}

/** Marks the artifact executable; Windows has no chmod semantics, so failure is not an error. */
export function makeExecutable(path) {
  try {
    chmodSync(path, 0o755);
  } catch {
    // ignore chmod failure on Windows
  }
}

/** Copies the builtin theme tree (packages/core/themes) to the target; a missing source dir errors loudly (releases ship styles, in-tree builds must have it). */
export function copyRepoStyles(...targets) {
  const source = `${REPO_ROOT}packages/core/themes`;
  if (!existsSync(source)) {
    process.stderr.write(
      "[build] missing packages/core/themes/: this package must build inside the source tree (releases ship their own styles/)\n",
    );
    process.exit(1);
  }
  for (const target of targets) cpSync(source, target, { recursive: true });
}

/** Runs repo-root tsc (a root devDependency); a nonzero exit code propagates verbatim. */
export function runTsc(args, { cwd = process.cwd() } = {}) {
  const result = spawnSync(process.execPath, [TSC, ...args], { cwd, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
