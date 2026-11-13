#!/usr/bin/env node
// 这层管：把 `hr` 转发给仓库里的 CLI 源码（子进程 + 退出码透传）；不含任何 HTML/CSS/YAML 逻辑。
// 零依赖：只用 node 内置模块；路径由 `import.meta.url` 推出，不读环境变量（M1.8 §8.2 裁定 #2）。

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `用法：node skills/hreader/scripts/hr.mjs <命令> [参数…]

  outline <file> [--json] [--workspace <dir>]
  read <file> <nodeId> [--json] [--max-bytes <n>]
  patch <file> <nodeId> --action <action> (--html <s> | --html-file <p> | --html-stdin) [--json]
  style <file> (--visual <id> | --tone <id> | --lint) [--json]
  --help | <命令> --help

退出码：0 成功 / 1 业务失败 / 2 用法错误 / 3 IO 与路径 / 70 内部错误。
`;

/** skills/hreader/scripts → 仓库根（三段上跳）。 */
const repoRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const entry = join(repoRoot, "packages", "cli", "src", "main.ts");

const fail = (message, code) => {
  process.stderr.write(`${message}\n`);
  process.exitCode = code;
};

const major = Number(process.versions.node.split(".")[0]);
if (major < 22) {
  fail(`需要 Node >= 22（当前 ${process.versions.node}）：CLI 直接跑 TypeScript 源码`, 70);
} else if (!existsSync(entry)) {
  fail(`找不到 CLI 入口：${entry}\n（hr.mjs 必须放在仓库的 skills/hreader/scripts/ 下）`, 70);
} else {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    process.stdout.write(USAGE);
    process.exitCode = 2;
  } else {
    const child = spawn(process.execPath, ["--experimental-strip-types", entry, ...argv], {
      stdio: ["inherit", "inherit", "inherit"],
    });
    child.on("error", (error) => {
      fail(`无法启动 CLI 子进程：${error.message}`, 70);
    });
    child.on("exit", (code, signal) => {
      if (signal !== null) {
        fail(`CLI 子进程被信号终止：${signal}`, 70);
        return;
      }
      process.exitCode = code ?? 70;
    });
  }
}
