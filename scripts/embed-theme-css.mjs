// Regenerate packages/core/src/templates/builtin/theme-css.ts from styles/<visual>/theme.css.
// 内置模板内嵌 CSS（D11：运行时不读文件系统）；两份数据的等价性由 builtin 测试的真实盘对拍锁定。
// Usage: node scripts/embed-theme-css.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "packages/core/src/templates/builtin/theme-css.ts");
const VISUALS = ["atelier-editorial", "deck-noir"];

const entries = VISUALS.map(
  (visual) =>
    `  ${JSON.stringify(visual)}: ${JSON.stringify(
      readFileSync(join(ROOT, "styles", visual, "theme.css"), "utf8"),
    )},`,
);
const keys = VISUALS.map((visual) => JSON.stringify(visual)).join(" | ");

const body = `// This file is generated from styles/<visual>/theme.css — DO NOT EDIT BY HAND.
// 两份数据的等价性由 tests/templates/builtin.test.ts 的真实盘对拍测试锁定：改样式时同步重生成。
// 重生成：node scripts/embed-theme-css.mjs（脚本把每个 visual 的 theme.css 写进本文件）。
export const THEME_CSS: Readonly<Record<${keys}, string>> = {
${entries.join("\n")}
};
`;

writeFileSync(OUT, body);
process.stdout.write(`embedded ${String(VISUALS.length)} themes → ${OUT}\n`);
