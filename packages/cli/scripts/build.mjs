// Cross-platform build of the standalone CLI artifact: `dist/cli.mjs` + `styles/` + `dist/styles/` (no shell-quoting differences).
import { rmSync } from "node:fs";

import { bundleNode, copyRepoStyles, makeExecutable } from "../../../scripts/esbuild.mjs";

rmSync("dist", { recursive: true, force: true });
rmSync("styles", { recursive: true, force: true });

await bundleNode({ entry: "src/main.ts", outfile: "dist/cli.mjs", shebang: true });
makeExecutable("dist/cli.mjs");
copyRepoStyles("styles", "dist/styles");
