// 这层管：真子进程层的对抗面——怪异文件名、import 的文件系统矩阵、退出码抽查。
// 纯 argv 的词法在 `argv-edge.test.ts`；这里跑的是整条进程（含 io 与落盘）。

import {
  chmodSync,
  existsSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { checked, seed } from "./cli-support";
import { runCli, withTempDir } from "./harness";

describe("怪异文件名（真子进程）", () => {
  it.each(["带 空格.html", "中文文档.html", "emoji 🚀.html"])("should outline %s", async (name) => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      seed(dir, name);
      const result = checked(await runCli(["outline", name], { cwd: dir }));

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("标题");
    });
  });

  it("should reject a dash-leading filename as an option, then accept it after --", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      seed(dir, "-weird.html");

      const bad = checked(await runCli(["outline", "-weird.html"], { cwd: dir }));
      expect(bad.code).toBe(2);
      expect(bad.stderr).toContain("未知参数：-w");

      const good = checked(await runCli(["outline", "--", "-weird.html"], { cwd: dir }));
      expect(good.code).toBe(0);
      expect(good.stdout).toContain("标题");
    });
  });
});

describe("hr import · 文件系统矩阵（真子进程）", () => {
  const FOREIGN = "<body><main><p>外来</p></main></body>";

  it("should fail io_failure (exit 3) when the target directory is read-only", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      const locked = join(dir, "locked");
      writeFileSync(join(dir, "src.html"), FOREIGN);
      // `locked/` 只读：`--out` 指进去，父目录不可写 → io_failure。
      const { mkdirSync } = await import("node:fs");
      mkdirSync(locked);
      chmodSync(locked, 0o555);

      const result = checked(
        await runCli(["import", "src.html", "--out", "locked/o.html"], { cwd: dir }),
      );

      expect(result.code).toBe(3);
      expect(result.stderr).toContain("原子写失败");
      chmodSync(locked, 0o755);
    });
  });

  it("should follow a symlinked source file", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      writeFileSync(join(dir, "real.html"), FOREIGN);
      symlinkSync(join(dir, "real.html"), join(dir, "link.html"));

      const result = checked(await runCli(["import", "link.html"], { cwd: dir }));

      expect(result.code).toBe(0);
      expect(existsSync(join(dir, "link.hr.html"))).toBe(true);
    });
  });

  it("should refuse to write through a dangling --out symlink as file_exists", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      writeFileSync(join(dir, "src.html"), FOREIGN);
      // 悬空 symlink：lstat 看得见它，`file_exists` 必须先拒（不让 rename 踩上去）。
      symlinkSync(join(dir, "nowhere", "x.html"), join(dir, "o.hr.html"));

      const result = checked(
        await runCli(["import", "src.html", "--out", "o.hr.html"], { cwd: dir }),
      );

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("目标已存在");
    });
  });

  it("should refuse --force through a symlink that points outside the workspace", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      const outside = join(dir, "..", `escape-${Date.now()}.html`);
      writeFileSync(join(dir, "src.html"), FOREIGN);
      symlinkSync(outside, join(dir, "o.hr.html"));

      const result = checked(
        await runCli(["import", "src.html", "--out", "o.hr.html", "--force"], { cwd: dir }),
      );

      expect(result.code).toBe(3);
      expect(result.stderr).toContain("拒绝写入");
      expect(existsSync(outside)).toBe(false);
    });
  });

  it("should reject importing a managed document (self-export) with exit 1", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      seed(dir, "managed.html");

      const result = checked(
        await runCli(["import", "managed.html", "--out", "copy.hr.html"], { cwd: dir }),
      );

      expect(result.code).toBe(1);
      expect(existsSync(join(dir, "copy.hr.html"))).toBe(false);
    });
  });

  it("should reject an unknown --kind with exit 2 and list the choices", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      writeFileSync(join(dir, "src.html"), FOREIGN);

      const result = checked(await runCli(["import", "src.html", "--kind", "bogus"], { cwd: dir }));

      expect(result.code).toBe(2);
      expect(result.stderr).toContain("--kind");
      expect(result.stderr).toContain("slides");
    });
  });
});

describe("退出码抽查（真子进程）", () => {
  it("should exit 2 with usage on stderr for an unknown subcommand", async () => {
    const result = checked(await runCli(["frobnicate"]));

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("未知命令：frobnicate");
    expect(result.stderr).toContain("用法");
  });

  it("should exit 2 for a missing required argument", async () => {
    const result = checked(await runCli(["patch"]));

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("patch 缺少 <file>");
  });

  it("should not hang when stdin is absent for commands that never read it", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      seed(dir);
      // stdin: ignore（harness 缺省）——不读 stdin 的命令必须照常完事。
      const result = checked(await runCli(["outline", "a.html"], { cwd: dir }));
      expect(result.code).toBe(0);
    });
  });
});
