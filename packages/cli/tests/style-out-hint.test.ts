// This layer covers the stderr hint line when `--out` lands outside the discovery chain (real subprocess; a hint is not an error, exit stays 0).

import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runCli, withTempDir, type CliResult } from "./harness";

const runOf = (dir: string, args: readonly string[]): Promise<CliResult> =>
  runCli(["style", "extract", ...args], { cwd: dir, env: { OPENCODE_API_KEY: "" } });

const seed = (dir: string, sub: string): string => {
  mkdirSync(join(dir, sub));
  const path = join(dir, "corpus.md");
  writeFileSync(path, "第一段一句。\n\n第二段两句。还有一句。\n");
  return path;
};

describe("hr style extract · --out discovery-path hint · display", () => {
  it("should quote the path as the user typed it", async () => {
    await withTempDir(async (dir) => {
      const file = seed(dir, "styles");
      const result = await runOf(dir, [file, "--id", "my-voice", "--out", "styles/my-voice.yaml"]);

      // Byte-pinned "the relative path the user typed is what is displayed"; the suggested target in the hint is an absolute path by design, out of assertion scope.
      expect(result.stderr).toContain("提示：styles/my-voice.yaml 不在风格发现路径里");
    });
  });
});

describe("hr style extract · --out discovery-path hint", () => {
  it("should hint when writing outside the two discovered locations", async () => {
    await withTempDir(async (dir) => {
      const file = seed(dir, "styles");
      const result = await runOf(dir, [file, "--id", "my-voice", "--out", "styles/my-voice.yaml"]);

      expect(result.code).toBe(0);
      expect(result.stderr).toContain("不在风格发现路径里");
      expect(result.stderr).toContain(".hreader/style.yaml");
    });
  });

  it("should stay quiet for the project-level .hreader/style.yaml", async () => {
    await withTempDir(async (dir) => {
      const file = seed(dir, ".hreader");
      const result = await runOf(dir, [file, "--id", "my-voice", "--out", ".hreader/style.yaml"]);

      expect(result.code).toBe(0);
      expect(result.stderr).not.toContain("不在风格发现路径里");
    });
  });

  it("should not hint when nothing was written", async () => {
    await withTempDir(async (dir) => {
      const file = seed(dir, "styles");
      writeFileSync(join(dir, "styles/my-voice.yaml"), "id: my-voice\n");
      const result = await runOf(dir, [file, "--id", "my-voice", "--out", "styles/my-voice.yaml"]);

      // `--out` was taken and nothing was written: printing "not on the discovery path" now would read as "already written".
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("目标已存在");
      expect(result.stderr).not.toContain("不在风格发现路径里");
    });
  });
});

describe("hr style extract · --out hints and symlinks", () => {
  it("should stay quiet when HOME reaches the target through a symlink", async () => {
    await withTempDir(async (dir) => {
      const root = realpathSync(mkdtempSync(join(dir, "link-root-")));
      const real = join(root, "real");
      mkdirSync(join(real, "home/.hreader/styles/a"), { recursive: true });
      symlinkSync(real, join(root, "link"), "dir");
      const home = join(root, "link/home");
      const file = seed(real, "corpus");

      const result = await runCli(
        [
          "style",
          "extract",
          file,
          "--id",
          "a",
          "--out",
          join(home, ".hreader/styles/a/style.yaml"),
        ],
        { cwd: home, env: { HOME: home, OPENCODE_API_KEY: "" } },
      );

      // Both paths are the same file (two sides of a symlink): saying "not on the discovery path" states the opposite of the truth.
      expect(result.code).toBe(0);
      expect(result.stderr).not.toContain("不在风格发现路径里");
    });
  });
});
