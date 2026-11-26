// This layer covers the real-subprocess CLI contract (exit codes, JSON, pipes, encoding, no ANSI); no process mocking.

import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runCli, withTempDir } from "./harness";
import { checked, seed, sha } from "./cli-support";

describe("exit code 0 · success", () => {
  it("should outline a document", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      seed(dir);
      const result = checked(await runCli(["outline", "a.html"], { cwd: dir }));

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("- hr-b  标题  (2w)\n");
      expect(result.stderr).toBe("");
    });
  });

  it("should print --help and exit 0", async () => {
    const result = checked(await runCli(["--help"]));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("hr patch <file> <nodeId|selector>");
  });
});

describe("exit code 1 · business failures", () => {
  it("should fail node_not_found without touching the file", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      const path = seed(dir);
      const before = sha(path);
      const result = checked(
        await runCli(["patch", "a.html", "hr-nope", "--action", "delete"], { cwd: dir }),
      );

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      // One sentence in the message: `hr-nope` is a legal id shape, absent from the doc — the node_not_found sentence.
      expect(result.stderr).toContain('文档里没有 id 为 "hr-nope" 的节点。');
      expect(sha(path)).toBe(before);
    });
  });
});

describe("exit code 1 · forbidden content", () => {
  it("should fail forbidden_content for a script fragment", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      const path = seed(dir);
      const before = sha(path);
      const result = checked(
        await runCli(
          [
            "patch",
            "a.html",
            "hr-c",
            "--action",
            "append",
            "--html",
            "<script>alert(1)</script>",
            "--json",
          ],
          { cwd: dir },
        ),
      );

      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout.trim())).toMatchObject({
        ok: false,
        code: "forbidden_content",
      });
      expect(sha(path)).toBe(before);
    });
  });
});

describe("exit code 1 · fragment validation", () => {
  it("should fail invalid_fragment for a fragment with two roots", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      seed(dir);
      const result = checked(
        await runCli(
          ["patch", "a.html", "hr-c", "--action", "append", "--html", "<p>a</p><p>b</p>"],
          {
            cwd: dir,
          },
        ),
      );

      // The fragment layer refuses first (`invalid_fragment`, exit 1): two roots can never fit one position in any container.
      // No more "unclosed `<div>`" as the illegal sample — a single-root fragment is now accepted by tolerant parsing and only fails at the content-model layer.
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("片段");
      expect(result.stderr).toContain("根元素");
    });
  });
});

describe("exit code 1 · missing styles", () => {
  it("should fail unknown_style for a theme that does not exist", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      seed(dir);
      const result = checked(
        await runCli(["style", "a.html", "--visual", "no-such"], { cwd: dir }),
      );

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("四个来源都找不到风格：no-such");
    });
  });
});

describe("exit code 2 · usage errors", () => {
  it("should exit 2 with the usage when no command is given", async () => {
    const result = checked(await runCli([]));

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "缺少命令：new | import | normalize | outline | read | patch | check",
    );
    expect(result.stderr).toContain("用法：");
  });

  it("should exit 2 for delete + --html (CLI layer, not core)", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      seed(dir);
      const result = checked(
        await runCli(["patch", "a.html", "hr-c", "--action", "delete", "--html", "<p>x</p>"], {
          cwd: dir,
        }),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toContain("delete 不接受 --html");
    });
  });

  it("should exit 2 for an unknown flag", async () => {
    const result = checked(await runCli(["outline", "a.html", "--nope"]));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("未知参数：--nope");
  });
});

describe("exit code 3 · IO and paths", () => {
  it("should exit 3 for a missing file", async () => {
    const result = checked(await runCli(["outline", "missing.html"]));
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("读取时路径不存在");
  });

  it("should exit 3 for ../x.html and never create the target", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      seed(dir);
      // Uniqueness: `escape.html` is a fixed name shared by several test files; one sloppy write elsewhere turns this red.
      const name = `hr-escape-patch-${String(process.pid)}-${String(Date.now())}.html`;
      const outside = join(dir, "..", name);
      try {
        const result = checked(
          await runCli(["patch", `../${name}`, "hr-c", "--action", "delete"], { cwd: dir }),
        );

        expect(result.code).toBe(3);
        expect(result.stderr).toContain("逃出了 workspace");
        expect(existsSync(outside)).toBe(false);
        expect(() => readFileSync(outside)).toThrow(/ENOENT/u);
      } finally {
        rmSync(outside, { force: true });
      }
    });
  });
});

describe("exit code 3 · bad encoding", () => {
  it("should exit 3 + invalid_utf8 for a bad document and keep the bytes", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      const path = join(dir, "bad.html");
      writeFileSync(path, Buffer.from([0xff, 0xfe, 0x3c]));
      const before = sha(path);
      const result = checked(
        await runCli(["patch", "bad.html", "hr-a", "--action", "delete", "--json"], { cwd: dir }),
      );

      expect(result.code).toBe(3);
      expect(JSON.parse(result.stdout.trim())).toMatchObject({ ok: false, code: "invalid_utf8" });
      expect(sha(path)).toBe(before);
    });
  });
});

describe("exit code 70 · internal errors (really triggered)", () => {
  it("should exit 70 when stdin cannot be read at all (write-only fd)", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      const path = seed(dir);
      const before = sha(path);
      const fd = openSync(join(dir, "w-only.txt"), "w");
      try {
        const result = checked(
          await runCli(["patch", "a.html", "hr-c", "--action", "append", "--html-stdin"], {
            cwd: dir,
            stdinFd: fd,
          }),
        );

        expect(result.code).toBe(70);
        expect(result.stderr).toContain("EBADF");
        expect(result.stderr).not.toContain("    at ");
        expect(sha(path)).toBe(before);
      } finally {
        closeSync(fd);
      }
    });
  });
});

describe("exit code 70 · HR_DEBUG stacks", () => {
  it("should print the stack only with HR_DEBUG=1", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      seed(dir);
      const fd = openSync(join(dir, "w-only.txt"), "w");
      try {
        const result = checked(
          await runCli(["patch", "a.html", "hr-c", "--action", "append", "--html-stdin"], {
            cwd: dir,
            stdinFd: fd,
            env: { HR_DEBUG: "1" },
          }),
        );

        expect(result.code).toBe(70);
        // A stream error's stack is only its first line (no `at` frames), but `--debug` still appends it.
        expect(result.stderr).toContain("EBADF: bad file descriptor, read\nError: EBADF");
      } finally {
        closeSync(fd);
      }
    });
  });
});
