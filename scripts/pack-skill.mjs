#!/usr/bin/env node
// Packs the Skill into a directory distributable without the source repo: `release-artifacts/hreader-skill/`.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_BUNDLE = join(REPO, "packages/cli/dist/cli.mjs");
const STYLES_SRC = join(REPO, "styles");
const SKILL_SRC = join(REPO, "skills/hreader");
const OUT = join(REPO, "release-artifacts/hreader-skill");

if (!existsSync(CLI_BUNDLE)) {
  execFileSync("pnpm", ["-C", "packages/cli", "build"], {
    cwd: REPO,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(SKILL_SRC, OUT, { recursive: true });
cpSync(CLI_BUNDLE, join(OUT, "scripts/cli.mjs"));
cpSync(STYLES_SRC, join(OUT, "scripts/styles"), { recursive: true });

process.stdout.write(`已打包独立 Skill 到 ${OUT}\n`);
