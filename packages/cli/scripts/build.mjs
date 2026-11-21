// 跨平台构建独立 CLI 产物：`dist/cli.mjs` + `styles/` + `dist/styles/`（无 shell 引号差异）。
import { chmodSync, cpSync, existsSync, rmSync } from "node:fs";
import { build } from "esbuild";

const BANNER =
  '#!/usr/bin/env node\nimport { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);';

async function main() {
  rmSync("dist", { recursive: true, force: true });
  rmSync("styles", { recursive: true, force: true });

  await build({
    entryPoints: ["src/main.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: "dist/cli.mjs",
    sourcemap: true,
    sourcesContent: false,
    banner: { js: BANNER },
  });

  if (!existsSync("../../styles")) {
    process.stderr.write("[build] 缺少 ../../styles/：请在源码树内构建 @hreader/cli\n");
    process.exit(1);
  }

  try {
    chmodSync("dist/cli.mjs", 0o755);
  } catch {
    // Windows 上忽略 chmod 失败
  }
  cpSync("../../styles", "styles", { recursive: true });
  cpSync("../../styles", "dist/styles", { recursive: true });
}

await main();
