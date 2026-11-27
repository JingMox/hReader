#!/usr/bin/env node
// 为 Tauri 打包准备内置静态资源：独立 CLI (`cli.mjs` + `styles/`) 与前端 (`app/dist/`)。
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const RES_ROOT = join(REPO, "packages/desktop/src-tauri/resources");
const APP_DIST = join(REPO, "packages/app/dist");
const CLI_DIST = join(REPO, "packages/cli/dist/cli.mjs");
const STYLES_SRC = join(REPO, "packages/core/themes");
const PNPM = "pnpm";
const SHELL = process.platform === "win32";

if (!existsSync(join(APP_DIST, "index.html"))) {
  execFileSync(PNPM, ["-C", "packages/app", "build"], {
    cwd: REPO,
    stdio: "inherit",
    shell: SHELL,
  });
}
if (!existsSync(CLI_DIST)) {
  execFileSync(PNPM, ["-C", "packages/cli", "build"], {
    cwd: REPO,
    stdio: "inherit",
    shell: SHELL,
  });
}

const outApp = join(RES_ROOT, "app");
const outCli = join(RES_ROOT, "cli");
rmSync(outApp, { recursive: true, force: true });
rmSync(outCli, { recursive: true, force: true });
mkdirSync(outApp, { recursive: true });
mkdirSync(outCli, { recursive: true });

cpSync(APP_DIST, outApp, { recursive: true });
cpSync(CLI_DIST, join(outCli, "cli.mjs"));
cpSync(STYLES_SRC, join(outCli, "styles"), { recursive: true });

process.stdout.write("已同步桌面端打包资源到 packages/desktop/src-tauri/resources/\n");
