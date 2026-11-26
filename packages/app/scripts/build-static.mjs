// This layer owns: copying `static/` (index.html + styles.css) into `dist/` — tsc only
// handles .ts. The daemon serves `dist/` statically: `/` → index.html, `/assets/*` →
// dist/assets/*.
//
// It also rewrites the tsc-emitted `dist/assets/version.js` into a baked literal:
// `src/version.ts` reads `package.json` on the Node side (vitest / typecheck), but the
// browser has no `node:fs`, so the version is baked into the artifact at build time —
// `package.json` stays the single source of truth.

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = dirname(here);
const out = join(app, "dist", "assets");

await mkdir(out, { recursive: true });
await copyFile(join(app, "static", "index.html"), join(app, "dist", "index.html"));
await copyFile(join(app, "static", "styles.css"), join(out, "styles.css"));

const { version } = JSON.parse(await readFile(join(app, "package.json"), "utf8"));
await writeFile(
  join(out, "version.js"),
  `// Baked at build time from package.json; see src/version.ts.\nexport const APP_VERSION = ${JSON.stringify(`v${version}`)};\n`,
);
