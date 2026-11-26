// This file covers `hr style extract` refusing corpus paths that are not
// regular files (directory, symlink to a device, FIFO); a normal corpus is
// covered by style-extract.
//
// Two sharp edges: "check the kind before reading" (an implementation that
// only looks at `stat.size` would admit /dev/zero and a FIFO, then read an
// unbounded stream or wait on a writer forever), and "stop at fileSizeOf"
// (when a directory name carries a valid corpus suffix, only the
// `isDirectory` branch produces the "是目录" refusal).

import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runCli, withTempDir } from "./harness";

const NO_KEY = { OPENCODE_API_KEY: "" };

const extract = async (args: readonly string[], dir: string) =>
  runCli(["style", "extract", "--no-llm", ...args], { cwd: dir, env: NO_KEY });

/**
 * "Does not hang" is not proven by a stopwatch: refusing after one `stat`
 * type check without touching `readFile` is pinned by the stubbed-fs test in
 * style-extract-corpus-kind; if a mutant entered the read path (unbounded
 * device, FIFO waiting on a writer), runCli's 10s hard timeout and vitest's
 * testTimeout would turn it red — no wall-clock assertion needed.
 */
const expectRefused = async (path: string, dir: string): Promise<void> => {
  const result = await extract([path, "--json"], dir);

  expect(result.code).toBe(1);
  expect(result.stdout).toContain('"code":"invalid_input"');
  expect(result.stdout).toContain("只能是普通文件");
};

describe("hr style extract · a directory as corpus", () => {
  it("should refuse a directory path that carries a valid corpus suffix", async () => {
    await withTempDir(async (dir) => {
      // Only a legal suffix (`.md`) reaches `fileSizeOf`; otherwise `formatOf` rejects by suffix and the `isDirectory` branch never runs.
      const path = join(dir, "corpus.md");
      mkdirSync(path);

      const result = await extract([path, "--json"], dir);

      expect(result.code).toBe(1);
      expect(result.stdout).toContain('"code":"invalid_input"');
      expect(result.stdout).toContain("是目录");
    });
  });
});

describe("hr style extract · devices and pipes", () => {
  // A deliberately accepted Windows no-op: this repo's CI is POSIX-only and `/dev/zero` has no Windows equivalent.
  it.skipIf(process.platform === "win32")(
    "should refuse a corpus that is a symlink to /dev/zero",
    async () => {
      await withTempDir(async (dir) => {
        const path = join(dir, "zero.md");
        symlinkSync("/dev/zero", path);

        await expectRefused(path, dir);
      });
    },
  );

  // A deliberately accepted Windows no-op: this repo's CI is POSIX-only and `mkfifo` has no Windows equivalent.
  it.skipIf(process.platform === "win32")("should refuse a corpus that is a fifo", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "pipe.md");
      execFileSync("mkfifo", [path]);

      await expectRefused(path, dir);
    });
  });
});
