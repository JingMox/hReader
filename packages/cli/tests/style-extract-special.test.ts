// 这层管：`hr style extract` 对非普通文件（符号链接到设备、FIFO）的拒绝；普通语料的行为见 style-extract。
//
// 这条用例的牙是"快"：只看 `stat.size` 的实现会给 `/dev/zero` 与 FIFO 放行，随后无界读或永等写入方。

import { execFileSync } from "node:child_process";
import { symlinkSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runCli, withTempDir } from "./harness";

const NO_KEY = { OPENCODE_API_KEY: "" };

const extract = async (args: readonly string[], dir: string) =>
  runCli(["style", "extract", "--no-llm", ...args], { cwd: dir, env: NO_KEY });

describe("hr style extract · 非普通文件", () => {
  /** `< 1s` 是这条用例的牙：改回只看 size 的实现会无界读 `/dev/zero` / 永等 FIFO，被 harness 的 10s 兜底判红。 */
  const expectRefusedFast = async (path: string, dir: string): Promise<void> => {
    const startedAt = Date.now();
    const result = await extract([path, "--json"], dir);

    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('"code":"invalid_input"');
    expect(result.stdout).toContain("只能是普通文件");
  };

  it.skipIf(process.platform === "win32")(
    "should refuse a corpus that is a symlink to /dev/zero",
    async () => {
      await withTempDir(async (dir) => {
        const path = join(dir, "zero.md");
        symlinkSync("/dev/zero", path);

        await expectRefusedFast(path, dir);
      });
    },
  );

  it.skipIf(process.platform === "win32")("should refuse a corpus that is a fifo", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "pipe.md");
      execFileSync("mkfifo", [path]);

      await expectRefusedFast(path, dir);
    });
  });
});
