// Regenerate packages/core/src/templates/builtin/theme-css.ts from packages/core/themes/<visual>/theme.css.
// The builtin templates embed the CSS (D11: no filesystem reads at runtime); the byte-for-byte
// equivalence of the two copies is locked by the real-disk comparison in builtin tests.
// Usage: node scripts/embed-theme-css.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { format, resolveConfig } from "prettier";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "packages/core/src/templates/builtin/theme-css.ts");
const VISUALS = ["atelier-editorial", "deck-noir"];

const entries = VISUALS.map(
  (visual) =>
    `  ${JSON.stringify(visual)}: ${JSON.stringify(
      readFileSync(join(ROOT, "packages", "core", "themes", visual, "theme.css"), "utf8"),
    )},`,
);
const keys = VISUALS.map((visual) => JSON.stringify(visual)).join(" | ");

const body = `// This file is generated from styles/<visual>/theme.css — DO NOT EDIT BY HAND.
// The byte-for-byte equivalence of the two copies is locked by the real-disk comparison in
// tests/templates/builtin.test.ts: regenerate when a theme changes.
// Regenerate: node scripts/embed-theme-css.mjs (writes every visual's theme.css into this file).
export const THEME_CSS: Readonly<Record<${keys}, string>> = {
${entries.join("\n")}
};
`;

// Emit prettier-formatted output so regeneration is byte-stable under `pnpm format:check`.
writeFileSync(OUT, await format(body, { ...(await resolveConfig(OUT)), parser: "typescript" }));
process.stdout.write(`embedded ${String(VISUALS.length)} themes → ${OUT}\n`);
