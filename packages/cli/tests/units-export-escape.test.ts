// 这层管：`exportPrintCommand` 的 `--out` 守卫（越界先于 file_exists、缺父目录归 io）；不起子进程。

import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { exportPrintCommand } from "../src/commands/exportPrint";
import { ARTICLE, inputOf } from "./export-print-fixtures";
import { withTempDir } from "./harness";

/**
 * 一律拿**真实路径**当 workspace：`run.ts` 在调命令前已把 workspace 与 `--out` 都真实化，
 * 而 macOS 的 `$TMPDIR` 是 `/var/...`、`realpath` 后是 `/private/var/...`——两侧不统一，
 * 词法越界判定会把同一个目录当成两个。
 */
const withRealDir = async (run: (dir: string) => Promise<void>): Promise<void> =>
  withTempDir(async (raw) => {
    await run(realpathSync(raw));
  });

describe("exportPrintCommand · --out 越界先于 file_exists", () => {
  it("should say path_outside_workspace even when the outside target exists", async () => {
    await withRealDir(async (dir) => {
      const path = join(dir, "doc.html");
      writeFileSync(path, ARTICLE);
      const outside = join(dir, "..", `hr-escape-unit-${String(process.pid)}.html`);
      writeFileSync(outside, "旧");
      try {
        await expect(exportPrintCommand(inputOf(path, { out: outside }))).rejects.toMatchObject({
          code: "path_outside_workspace",
        });
        expect(readFileSync(outside, "utf8")).toBe("旧");
      } finally {
        rmSync(outside, { force: true });
      }
    });
  });

  it("should keep io_failure for a missing --out parent directory", async () => {
    await withRealDir(async (dir) => {
      const path = join(dir, "doc.html");
      writeFileSync(path, ARTICLE);
      const out = join(dir, "missing/print.html");
      await expect(exportPrintCommand(inputOf(path, { out }))).rejects.toMatchObject({
        code: "io_failure",
      });
      expect(existsSync(out)).toBe(false);
    });
  });
});
