// 跨平台构建 dsh bundle：`dist/index.js` + 摊平的 `.d.ts` + `dist/styles/`。
import { copyFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { bundleNode, copyRepoStyles, runTsc } from "../../../scripts/esbuild.mjs";

rmSync("dist", { recursive: true, force: true });

await bundleNode({ entry: "src/index.ts", outfile: "dist/index.js" });

// 声明文件单独出一份：tsc 按包路径铺在 dist/.types 下，摊平到 dist/ 顶层发布。
runTsc(["-p", "tsconfig.build.json", "--noCheck"]);
const typesDir = "dist/.types/dsh-bundle/src";
for (const name of readdirSync(typesDir)) {
  if (name.endsWith(".d.ts")) copyFileSync(join(typesDir, name), join("dist", name));
}
rmSync("dist/.types", { recursive: true, force: true });

copyRepoStyles("dist/styles");
