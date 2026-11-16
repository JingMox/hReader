// 这层管：`hr style extract` 拒绝"不是普通文件"的语料路径（目录、符号链接到设备、FIFO）；普通语料见 style-extract。
//
// 牙有两处：一是"快"（只看 `stat.size` 的实现会给 `/dev/zero` 与 FIFO 放行，随后无界读或永等写入方），
// 二是"停在 fileSizeOf"（目录名带合法后缀时，只有 `isDirectory` 那支会给出"是目录"）。

import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runCli, withTempDir } from "./harness";

const NO_KEY = { OPENCODE_API_KEY: "" };

const extract = async (args: readonly string[], dir: string) =>
  runCli(["style", "extract", "--no-llm", ...args], { cwd: dir, env: NO_KEY });

/** 10s harness 兜底之外，这里要求"立刻"拒：放行就意味着去读一个无界或永不就绪的流。 */
const expectRefusedFast = async (path: string, dir: string): Promise<void> => {
  const startedAt = Date.now();
  const result = await extract([path, "--json"], dir);

  // 1s 是宽松上限：满负载实测最大 209ms（4.78× 余量）。变异体会以 vitest 的 5s testTimeout 变红，
  // 不是这条断言兜底——所以它证明的是"没挂死"，不是"没超限"。
  expect(Date.now() - startedAt).toBeLessThan(1000);
  expect(result.code).toBe(1);
  expect(result.stdout).toContain('"code":"invalid_input"');
  expect(result.stdout).toContain("只能是普通文件");
};

describe("hr style extract · 目录当语料", () => {
  it("should refuse a directory path that carries a valid corpus suffix", async () => {
    await withTempDir(async (dir) => {
      // 后缀合法（`.md`）才会走到 `fileSizeOf`；否则 `formatOf` 先按后缀拒掉，`isDirectory` 那支永远碰不到。
      const path = join(dir, "corpus.md");
      mkdirSync(path);

      const result = await extract([path, "--json"], dir);

      expect(result.code).toBe(1);
      expect(result.stdout).toContain('"code":"invalid_input"');
      expect(result.stdout).toContain("是目录");
    });
  });
});

describe("hr style extract · 设备与管道", () => {
  // 刻意接受的 Windows 空跑：本仓 CI 只跑 POSIX，`/dev/zero` 在 Windows 没有等价物。
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

  // 刻意接受的 Windows 空跑：本仓 CI 只跑 POSIX，`mkfifo` 在 Windows 没有等价物。
  it.skipIf(process.platform === "win32")("should refuse a corpus that is a fifo", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "pipe.md");
      execFileSync("mkfifo", [path]);

      await expectRefusedFast(path, dir);
    });
  });
});
