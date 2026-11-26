// Manual smoke gate for the dsh bundle — this repo depends on **rc** versions of `@deepseek-ai/*`,
// and `dsh.compatibility.dshReleases` is not even in the `DshManifest` type (copied from a third-party
// plugin's empirically-working form), so only a real `dsh` install proves whether the manifest is
// accepted. **Not in CI** (requires a local dsh install and real processes).
// Usage: `pnpm smoke:dsh`.
//
// All verdicts land on reproducible signals:
//   1. no local `dsh` → SKIP (not a failure: this is an optional gate);
//   2. `packages/dsh-bundle`'s `build` produces a self-contained `dist/index.js`;
//   3. `dsh plugin --profile smoke add <package dir>` exits 0 (manifest accepted);
//   4. `dsh --profile smoke --dump-config`'s merged tree contains this plugin (comment header +
//      id + name, three lines).
// A real dsh's `--profile` takes a **name**, not a path; profiles live in
// `$DSH_HOME/profiles/<name>`. So this run creates a temporary `$DSH_HOME` and never touches the
// user's `~/.dsh`.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = fileURLToPath(new URL("../packages/dsh-bundle/", import.meta.url));
const PLUGIN_NAME = "@hreader/dsh-bundle";
const PROFILE_NAME = "smoke";
const TIMEOUT_MS = 180_000;
const TAIL_CHARS = 1200;

interface Run {
  /** The command itself is not on PATH (ENOENT): the smoke treats it as "not installed", not a failure. */
  readonly missing: boolean;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const run = (command: string, args: readonly string[], env?: NodeJS.ProcessEnv): Run => {
  const result = spawnSync(command, args, {
    cwd: PACKAGE_DIR,
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    ...(env === undefined ? {} : { env }),
  });
  // On `spawnSync` failure the errno lands on `error.code`; Node's types only declare `Error`.
  const missing =
    String(Object.getOwnPropertyDescriptor(result.error ?? {}, "code")?.value) === "ENOENT";
  if (result.error !== undefined && !missing) throw result.error;
  return { missing, status: result.status, stdout: result.stdout, stderr: result.stderr };
};

const tail = (text: string): string => text.trim().slice(-TAIL_CHARS) || "（空）";

const failures: string[] = [];
const check = (passed: boolean, label: string, detail: string): void => {
  process.stdout.write(`${passed ? "✓" : "✗"} ${label}\n`);
  if (!passed) failures.push(`${label}——${detail}`);
};

const probe = run("dsh", ["--version"]);
if (probe.missing || probe.status !== 0) {
  process.stdout.write(
    `SKIP 烟测：本机没有可用的 \`dsh\`（\`dsh --version\` 退出 ${String(probe.status)}）。\n` +
      "装了之后才能验真宿主面，例如：\n" +
      "  npm i -D @deepseek-ai/dsh@0.2.2-rc.1\n" +
      '  PATH="$PWD/node_modules/.bin:$PATH" pnpm smoke:dsh\n',
  );
  process.exitCode = 0;
} else {
  process.stdout.write(`dsh 版本：${probe.stdout.trim() || "（无输出）"}\n`);

  const built = run("pnpm", ["-C", PACKAGE_DIR, "build"]);
  check(
    built.status === 0 && existsSync(join(PACKAGE_DIR, "dist/index.js")),
    "`pnpm -C packages/dsh-bundle build` 产出 dist/index.js",
    tail(`${built.stdout}${built.stderr}`),
  );

  const home = mkdtempSync(join(tmpdir(), "hreader-dsh-home-"));
  const dshEnv = { ...process.env, DSH_HOME: home };
  const added = run("dsh", ["plugin", "--profile", PROFILE_NAME, "add", PACKAGE_DIR], dshEnv);
  const addRaw = `退出码 ${String(added.status)}\n读者请对照 dsh 原文判断：\n--- stdout ---\n${tail(
    added.stdout,
  )}\n--- stderr ---\n${tail(added.stderr)}`;

  check(
    added.status === 0,
    "`dsh plugin add` 接受这份清单（bundle.patch + compatibility）",
    addRaw,
  );

  const dumped = run("dsh", ["--profile", PROFILE_NAME, "--dump-config"], dshEnv);
  const dumpRaw = `退出码 ${String(dumped.status)}\n--- dump-config stdout 尾巴 ---\n${tail(
    dumped.stdout,
  )}\n--- stderr ---\n${tail(dumped.stderr)}`;

  check(
    dumped.status === 0 && dumped.stdout.includes(`# == ${PLUGIN_NAME}`),
    `--dump-config 合成树里出现注释头 \`# == ${PLUGIN_NAME}\``,
    dumpRaw,
  );
  check(
    dumped.status === 0 && dumped.stdout.includes("- id: hreader"),
    "--dump-config 合成树里出现 `- id: hreader`",
    dumpRaw,
  );
  check(
    dumped.status === 0 && dumped.stdout.includes(`name: '${PLUGIN_NAME}'`),
    `--dump-config 合成树里出现 \`name: '${PLUGIN_NAME}'\``,
    dumpRaw,
  );

  if (failures.length > 0) {
    process.stderr.write(`\n烟测失败 ${String(failures.length)} 条：\n${failures.join("\n\n")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `\n烟测通过：真 dsh 装下了 ${PLUGIN_NAME}（DSH_HOME=${home}，profile=${PROFILE_NAME}）。\n`,
    );
  }
}
