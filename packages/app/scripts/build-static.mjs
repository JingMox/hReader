// 这层管：把 `static/` 里的 index.html 与 styles.css 复制进 `dist/`（tsc 只管 .ts）。
// daemon 静态托管 `dist/`：`/` → index.html，`/assets/*` → dist/assets/*。

import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = dirname(here);
const out = join(app, "dist", "assets");

await mkdir(out, { recursive: true });
await copyFile(join(app, "static", "index.html"), join(app, "dist", "index.html"));
await copyFile(join(app, "static", "styles.css"), join(out, "styles.css"));
