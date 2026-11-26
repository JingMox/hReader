// This layer covers the adversarial side at the real-subprocess level — weird filenames, import's filesystem matrix, spot-checked exit codes.
// Pure argv lexing lives in `argv-edge.test.ts`; here the whole process runs (io and disk included).

import { chmodSync, existsSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { checked, seed } from "./cli-support";
import { runCli, withTempDir } from "./harness";

describe("weird filenames (real subprocess)", () => {
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

describe("hr import · filesystem matrix (real subprocess)", () => {
  const FOREIGN = "<body><main><p>外来</p></main></body>";

  it("should fail io_failure (exit 3) when the target directory is read-only", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      const locked = join(dir, "locked");
      writeFileSync(join(dir, "src.html"), FOREIGN);
      // `locked/` is read-only: `--out` pointed inside → unwritable parent → io_failure.
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
      // A dangling symlink: lstat sees it, so `file_exists` must refuse first (rename must not step on it).
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
      const outside = join(dir, "..", "escape.html");
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

describe("exit-code spot checks (real subprocess)", () => {
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
      // stdin: ignore (the harness default) — commands that never read stdin must finish normally.
      const result = checked(await runCli(["outline", "a.html"], { cwd: dir }));
      expect(result.code).toBe(0);
    });
  });
});
