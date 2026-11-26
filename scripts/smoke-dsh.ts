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

const tail = (text: string): string => text.trim().slice(-TAIL_CHARS) || "(empty)";

const failures: string[] = [];
const check = (passed: boolean, label: string, detail: string): void => {
  process.stdout.write(`${passed ? "✓" : "✗"} ${label}\n`);
  if (!passed) failures.push(`${label}——${detail}`);
};

const probe = run("dsh", ["--version"]);
if (probe.missing || probe.status !== 0) {
  process.stdout.write(
    `SKIP smoke test: no usable \`dsh\` on this machine (\`dsh --version\` exited ${String(probe.status)}).\n` +
      "Install it to verify against the real host, e.g.:\n" +
      "  npm i -D @deepseek-ai/dsh@0.2.2-rc.1\n" +
      '  PATH="$PWD/node_modules/.bin:$PATH" pnpm smoke:dsh\n',
  );
  process.exitCode = 0;
} else {
  process.stdout.write(`dsh version: ${probe.stdout.trim() || "(no output)"}\n`);

  const built = run("pnpm", ["-C", PACKAGE_DIR, "build"]);
  check(
    built.status === 0 && existsSync(join(PACKAGE_DIR, "dist/index.js")),
    "`pnpm -C packages/dsh-bundle build` produces dist/index.js",
    tail(`${built.stdout}${built.stderr}`),
  );

  const home = mkdtempSync(join(tmpdir(), "hreader-dsh-home-"));
  const dshEnv = { ...process.env, DSH_HOME: home };
  const added = run("dsh", ["plugin", "--profile", PROFILE_NAME, "add", PACKAGE_DIR], dshEnv);
  const addRaw = `exit code ${String(added.status)}\ncompare against dsh's own output to judge:\n--- stdout ---\n${tail(
    added.stdout,
  )}\n--- stderr ---\n${tail(added.stderr)}`;

  check(
    added.status === 0,
    "`dsh plugin add` accepts this manifest (bundle.patch + compatibility)",
    addRaw,
  );

  const dumped = run("dsh", ["--profile", PROFILE_NAME, "--dump-config"], dshEnv);
  const dumpRaw = `exit code ${String(dumped.status)}\n--- dump-config stdout tail ---\n${tail(
    dumped.stdout,
  )}\n--- stderr ---\n${tail(dumped.stderr)}`;

  check(
    dumped.status === 0 && dumped.stdout.includes(`# == ${PLUGIN_NAME}`),
    `--dump-config merged tree contains the comment header \`# == ${PLUGIN_NAME}\``,
    dumpRaw,
  );
  check(
    dumped.status === 0 && dumped.stdout.includes("- id: hreader"),
    "--dump-config merged tree contains `- id: hreader`",
    dumpRaw,
  );
  check(
    dumped.status === 0 && dumped.stdout.includes(`name: '${PLUGIN_NAME}'`),
    `--dump-config merged tree contains \`name: '${PLUGIN_NAME}'\``,
    dumpRaw,
  );

  if (failures.length > 0) {
    process.stderr.write(
      `\nsmoke failures (${String(failures.length)}):\n${failures.join("\n\n")}\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `\nsmoke passed: real dsh installed ${PLUGIN_NAME} (DSH_HOME=${home}, profile=${PROFILE_NAME}).\n`,
    );
  }
}
