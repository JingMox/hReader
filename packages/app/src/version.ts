// This layer owns: the version string shown in the status bar. The single source of truth
// is this package's `package.json`, read once at module load so tests and typecheck see the
// real value. The browser never executes this file: `pnpm build` rewrites the emitted
// `dist/assets/version.js` into a baked literal (see `scripts/build-static.mjs`), so
// `APP_VERSION` is the only export shipped code may import.

import { readFileSync } from "node:fs";

import { isRecord, stringOf } from "./guard.ts";

/** Manifest → `v`-prefixed display version; a missing string `version` breaks a build precondition, so throw. */
export const versionTextOf = (manifest: unknown): string => {
  const version = isRecord(manifest) ? stringOf(manifest["version"]) : undefined;
  if (version === undefined) {
    throw new Error('package.json must declare a string "version"');
  }
  return `v${version}`;
};

export const APP_VERSION = versionTextOf(
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")),
);
