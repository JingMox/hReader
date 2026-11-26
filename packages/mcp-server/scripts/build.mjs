// 跨平台构建可交付产物：tsc 先过类型，再出 `dist/main.js`（shebang 可执行）+ `styles/`。
import { rmSync } from "node:fs";

import { bundleNode, copyRepoStyles, makeExecutable, runTsc } from "../../../scripts/esbuild.mjs";

rmSync("dist", { recursive: true, force: true });
rmSync("styles", { recursive: true, force: true });

runTsc(["--noEmit", "-p", "tsconfig.build.json"]);
await bundleNode({ entry: "src/main.ts", outfile: "dist/main.js", shebang: true });
makeExecutable("dist/main.js");
copyRepoStyles("styles");
