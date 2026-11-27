#!/usr/bin/env node
// This layer: forward `hr` to the sibling single-file CLI build or the repo source entry
// (child process / in-process + exit-code passthrough); zero dependencies — node builtins only.
// Prefers the bundled artifact `./cli.mjs`, then the repo's `packages/cli/src/main.ts`.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// USAGE and the `fail()` messages below are product output asserted by tests
// (packages/cli/tests/skill-shell.test.ts) — they stay in Chinese verbatim.
const USAGE = `用法：node skills/hreader/scripts/hr.mjs <命令> [参数…]

  outline <file> [--json] [--workspace <dir>]
  read <file> <nodeId> [--json] [--max-bytes <n>]
  patch <file> <nodeId> --action <action> (--html <s> | --html-file <p> | --html-stdin) [--json]
  style <file> (--visual <id> | --tone <id> | --lint) [--json]
  --help | <命令> --help

退出码：0 成功 / 1 业务失败 / 2 用法错误 / 3 IO 与路径 / 70 内部错误。
`;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const bundledCli = join(scriptDir, "cli.mjs");
/** skills/hreader/scripts → repo root (three levels up). */
const repoRoot = dirname(dirname(dirname(scriptDir)));
const repoEntry = join(repoRoot, "packages", "cli", "src", "main.ts");

const fail = (message, code) => {
  process.stderr.write(`${message}\n`);
  process.exitCode = code;
};

const wireChild = (child) => {
  const forward = (signal) => () => {
    if (child.exitCode === null) child.kill(signal);
  };
  process.once("SIGTERM", forward("SIGTERM"));
  process.once("SIGINT", forward("SIGINT"));
  child.on("error", (error) => {
    fail(`无法启动 CLI 子进程：${error.message}`, 70);
  });
  child.on("exit", (code, signal) => {
    if (code === null) {
      fail(`CLI 子进程被信号终止：${String(signal)}`, 70);
      return;
    }
    process.exitCode = code;
  });
};

const runBundled = async (argv) => {
  if (argv.length === 0) {
    process.stdout.write(USAGE);
    process.exitCode = 2;
    return;
  }
  await import(pathToFileURL(bundledCli).href);
};

const runRepoSource = async (argv) => {
  if (argv.length === 0) {
    process.stdout.write(USAGE);
    process.exitCode = 2;
    return;
  }
  // Node >= 22.18 / 24 enables TS type stripping by default, so the entry is imported in-process —
  // a wrapper child process would swap the PID (the desktop shell maps `/healthz` by child PID).
  if (process.features.typescript) {
    await import(pathToFileURL(repoEntry).href);
    return;
  }
  const child = spawn(process.execPath, ["--experimental-strip-types", repoEntry, ...argv], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  wireChild(child);
};

const argv = process.argv.slice(2);
if (existsSync(bundledCli)) {
  await runBundled(argv);
} else if (existsSync(repoEntry)) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 15)) {
    fail(
      `需要 Node >= 22.15（当前 ${process.versions.node}）：源码模式依赖 module.registerHooks`,
      70,
    );
  } else {
    await runRepoSource(argv);
  }
} else {
  const child = spawn("hr", argv, { stdio: ["inherit", "inherit", "inherit"] });
  wireChild(child);
}
