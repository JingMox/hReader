// 跨平台构建独立 CLI 产物：`dist/cli.mjs` + `styles/` + `dist/styles/`（无 shell 引号差异）。
import { rmSync } from "node:fs";

import { bundleNode, copyRepoStyles, makeExecutable } from "../../../scripts/esbuild.mjs";

rmSync("dist", { recursive: true, force: true });
rmSync("styles", { recursive: true, force: true });

await bundleNode({ entry: "src/main.ts", outfile: "dist/cli.mjs", shebang: true });
makeExecutable("dist/cli.mjs");
copyRepoStyles("styles", "dist/styles");
