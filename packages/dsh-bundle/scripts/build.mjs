// Cross-platform build of the dsh bundle: `dist/index.js` + flattened `.d.ts` + `dist/styles/`.
import { copyFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { bundleNode, copyRepoStyles, runTsc } from "../../../scripts/esbuild.mjs";

rmSync("dist", { recursive: true, force: true });

await bundleNode({ entry: "src/index.ts", outfile: "dist/index.js" });

// Declarations ship separately: tsc lays them out under dist/.types by package path, flattened to dist/ top level.
runTsc(["-p", "tsconfig.build.json", "--noCheck"]);
const typesDir = "dist/.types/dsh-bundle/src";
for (const name of readdirSync(typesDir)) {
  if (name.endsWith(".d.ts")) copyFileSync(join(typesDir, name), join("dist", name));
}
rmSync("dist/.types", { recursive: true, force: true });

copyRepoStyles("dist/styles");
