// Cross-platform build of the deliverable: tsc checks types first, then emits `dist/main.js` (shebang-executable) + `styles/`.
import { rmSync } from "node:fs";

import { bundleNode, copyRepoStyles, makeExecutable, runTsc } from "../../../scripts/esbuild.mjs";

rmSync("dist", { recursive: true, force: true });
rmSync("styles", { recursive: true, force: true });

runTsc(["--noEmit", "-p", "tsconfig.build.json"]);
await bundleNode({ entry: "src/main.ts", outfile: "dist/main.js", shebang: true });
makeExecutable("dist/main.js");
copyRepoStyles("styles");
