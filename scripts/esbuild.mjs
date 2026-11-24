// 这层管：cli / mcp-server / dsh-bundle 三个包共用的 esbuild 打包约定；
// 不管各包特有的前后步骤（tsc、styles、chmod），那些留在各自的 scripts/build.mjs。
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const TSC = require.resolve("typescript/bin/tsc");

// ESM 产物里没有 CJS 的 __filename/__dirname；被打进来的 CJS 依赖（如 write-file-atomic）
// 会用到它们——define 丢了，产物的写盘路径在运行时才崩。
const COMPAT_DEFINE = {
  __filename: "import.meta.filename",
  __dirname: "import.meta.dirname",
};

// 同理由来：打进 ESM 产物的 CJS 依赖内部仍会 `require(...)`，用 createRequire 补一个。
const REQUIRE_BANNER =
  'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);';
const SHEBANG = "#!/usr/bin/env node";

/**
 * 打出一个 node ESM 单文件产物。
 * @param {{ entry: string, outfile: string, shebang?: boolean }} options
 */
export async function bundleNode({ entry, outfile, shebang = false }) {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile,
    sourcemap: true,
    sourcesContent: false,
    logLevel: "warning",
    banner: { js: shebang ? `${SHEBANG}\n${REQUIRE_BANNER}` : REQUIRE_BANNER },
    define: COMPAT_DEFINE,
  });
}

/** 给产物加可执行位；Windows 上没有 chmod 语义，失败不算错误。 */
export function makeExecutable(path) {
  try {
    chmodSync(path, 0o755);
  } catch {
    // Windows 上忽略 chmod 失败
  }
}

/** 把仓库根的 styles/ 拷到目标位置；缺源目录时明确报错（发行版自带 styles，源码树内构建必须有）。 */
export function copyRepoStyles(...targets) {
  const source = `${REPO_ROOT}styles`;
  if (!existsSync(source)) {
    process.stderr.write(
      "[build] 缺少仓库根 styles/：本包构建需在源码树内执行，发行版自带 styles/\n",
    );
    process.exit(1);
  }
  for (const target of targets) cpSync(source, target, { recursive: true });
}

/** 跑仓库根的 tsc（root devDependency）；非 0 退出码原样透传。 */
export function runTsc(args, { cwd = process.cwd() } = {}) {
  const result = spawnSync(process.execPath, [TSC, ...args], { cwd, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
