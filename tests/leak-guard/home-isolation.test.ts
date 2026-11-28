// This layer: the test-home isolation contract itself — every worker's HOME / USERPROFILE /
// HREADER_HOME and the XDG roots live under a per-process temp dir (tests/setup/isolate-home.ts
// via setupFiles), provably disjoint from the account's real home. The real home is detected
// through `os.userInfo().homedir`, which answers via getpwuid and therefore ignores $HOME.

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const SETUP_MODULE = pathToFileURL(
  fileURLToPath(new URL("../setup/isolate-home.ts", import.meta.url)),
).href;

/** A path that lives under os.tmpdir(), tolerant of tmpdir itself being a symlink (macOS /var → /private/var). */
const underTmpdir = (path: string): boolean => {
  if (path.startsWith(tmpdir())) return true;
  try {
    return realpathSync(path).startsWith(realpathSync(tmpdir()));
  } catch {
    return false;
  }
};

/** The account's real home; `undefined` on scratch images without a passwd entry (only the tmpdir side is checkable there). */
const passwdHome = (): string | undefined => {
  try {
    return userInfo().homedir;
  } catch {
    return undefined;
  }
};

/** Run a one-shot child and return its stdout; the env is inherited, so it sees this worker's isolation. */
const probe = (args: readonly string[]): string => {
  const child = spawnSync(process.execPath, [...args], { encoding: "utf8" });
  expect(child.status).toBe(0);
  expect(child.stderr).toBe("");
  return child.stdout.trim();
};

describe("test-home isolation", () => {
  it("should resolve os.homedir() to an existing dir under os.tmpdir()", () => {
    expect(underTmpdir(homedir())).toBe(true);
    expect(existsSync(homedir())).toBe(true);
  });

  it("should point HOME, USERPROFILE and HREADER_HOME at that same dir under os.tmpdir()", () => {
    for (const key of ["HOME", "USERPROFILE", "HREADER_HOME"]) {
      expect(process.env[key], key).toBe(homedir());
      expect(underTmpdir(process.env[key] ?? ""), key).toBe(true);
    }
  });

  it("should root the XDG dirs inside the isolated home", () => {
    for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) {
      const value = process.env[key];
      expect(value, key).toBeDefined();
      expect(value?.startsWith(`${homedir()}/`), key).toBe(true);
    }
  });

  it("should resolve to a home that differs from the real passwd home", () => {
    const real = passwdHome();
    expect(real).toBeDefined();
    if (real === undefined) return;
    for (const candidate of [homedir(), process.env["HOME"], process.env["HREADER_HOME"]]) {
      expect(candidate, String(candidate)).toBeDefined();
      expect(candidate).not.toBe(real);
      expect(candidate?.startsWith(real) ?? true).toBe(false);
    }
  });

  it("should let a spawned child process see the same temp home", () => {
    const childHome = probe([
      "--input-type=module",
      "-e",
      'import { homedir } from "node:os"; console.log(homedir());',
    ]);

    expect(childHome).toBe(homedir());
  });

  it("should give each process its own home — a second evaluation never borrows this worker's", () => {
    const childHome = probe([
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `import "${SETUP_MODULE}"; console.log(process.env["HOME"]);`,
    ]);

    expect(underTmpdir(childHome)).toBe(true);
    expect(childHome).not.toBe(homedir());
    const real = passwdHome();
    if (real !== undefined) expect(childHome.startsWith(real)).toBe(false);
  });
});
