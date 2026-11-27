// This layer covers where `run(["serve", …])` lands without `--home`.
// Why its own file: this case really starts one server — a different source from `run.test.ts`'s fake-io cases (same split as `run-paths.test.ts`).

import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";

import { run, type CliIo } from "../src/run";

// At module top, `HOME` is pointed at a sandbox first: `run()`'s landing is `io.home ?? homedir()` — break that
// wiring and it falls back to `homedir()`; without the redirect this file would write the real `~/.hreader/daemon.json` before the assertion fails (a real incident).
// Module-top `process.env` rewrites must be self-restored: `afterAll` deletes the sandbox, and unrestored the
// next test file in the same worker would see `homedir()` pointing at a deleted directory (a worker runs several files, see vitest.shared.ts).
const previousHome = process.env["HOME"];
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "hr-run-home-env-")));
process.env["HOME"] = sandbox;

const dir = realpathSync(mkdtempSync(join(tmpdir(), "hr-run-home-")));
const home = realpathSync(mkdtempSync(join(tmpdir(), "hr-run-state-")));
writeFileSync(
  join(dir, "a.html"),
  '<article data-hr-id="hr-a"><h2 data-hr-id="hr-b">标题</h2><p data-hr-id="hr-c">正文</p></article>',
);
afterAll(() => {
  // Restore `HOME` first, then delete the sandbox: reversed, `HOME` is left pointing at a nonexistent directory.
  if (previousHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = previousHome;
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(sandbox, { recursive: true, force: true });
});

const ioWith = (
  homePath: string | undefined,
  stop: Promise<void>,
  env: Readonly<Record<string, string>> = {},
): CliIo => ({
  cwd: dir,
  stdout: () => undefined,
  stderr: () => undefined,
  readStdin: () => Promise.resolve(new Uint8Array()),
  debug: false,
  launchParentPid: process.ppid,
  env,
  stop,
  ...(homePath === undefined ? {} : { home: homePath }),
});

const waitForOf = async (check: () => boolean): Promise<boolean> => {
  for (let index = 0; index < 500; index += 1) {
    if (check()) return true;
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  return false;
};

// Guard: `homedir()` must already be redirected to the sandbox. Otherwise a broken wire falls back to writing
// the real `~/.hreader` — presenting as "production data was touched" instead of "this case went red".
it("should have redirected HOME to a temp dir, so a broken wiring cannot touch the real one", () => {
  expect(homedir().startsWith(sandbox)).toBe(true);
});

it("should write daemon.json under the injected home when --home is absent", async () => {
  let release: () => void = () => undefined;
  const stop = new Promise<void>((resolve) => {
    release = resolve;
  });

  const running = run(["serve", "a.html", "--port", "0", "--json"], ioWith(home, stop));
  const daemon = join(home, ".hreader", "daemon.json");
  const appeared = await waitForOf(() => existsSync(daemon));
  release();

  expect(await running).toBe(0);
  expect(appeared).toBe(true);
  expect(await waitForOf(() => !existsSync(daemon))).toBe(true);
}, 20_000);

// `HREADER_HOME` is the env-level way to relocate the config root: unlike `HOME` it is not
// inherited by the spawned Chrome (an empty/poisoned HOME stalls the browser's network stack).
it("should write daemon.json under HREADER_HOME when io.home is unset", async () => {
  const envHome = realpathSync(mkdtempSync(join(tmpdir(), "hr-env-home-")));
  let release: () => void = () => undefined;
  const stop = new Promise<void>((resolve) => {
    release = resolve;
  });

  const running = run(
    ["serve", "a.html", "--port", "0", "--json"],
    ioWith(undefined, stop, { HREADER_HOME: envHome }),
  );
  const daemon = join(envHome, ".hreader", "daemon.json");
  const appeared = await waitForOf(() => existsSync(daemon));
  release();

  expect(await running).toBe(0);
  expect(appeared).toBe(true);
  expect(await waitForOf(() => !existsSync(daemon))).toBe(true);
  rmSync(envHome, { recursive: true, force: true });
}, 20_000);

it("should treat an empty HREADER_HOME as unset and fall back to homedir()", async () => {
  let release: () => void = () => undefined;
  const stop = new Promise<void>((resolve) => {
    release = resolve;
  });

  // The module-top sandbox owns homedir(): daemon.json lands under it, not under "".
  const running = run(
    ["serve", "a.html", "--port", "0", "--json"],
    ioWith(undefined, stop, { HREADER_HOME: "" }),
  );
  const daemon = join(sandbox, ".hreader", "daemon.json");
  const appeared = await waitForOf(() => existsSync(daemon));
  release();

  expect(await running).toBe(0);
  expect(appeared).toBe(true);
  expect(await waitForOf(() => !existsSync(daemon))).toBe(true);
}, 20_000);
