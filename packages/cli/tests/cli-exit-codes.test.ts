// 这层管：真子进程的 CLI 契约（退出码、JSON、管道、编码、无 ANSI）；不 mock 进程。

import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runCli, withTempDir } from "./harness";
import { checked, seed, sha } from "./cli-support";

describe("退出码 0 · 成功", () => {
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

describe("退出码 1 · 业务失败", () => {
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
      // F19 起报文只有一句：`hr-nope` 是合规 id 形态、文档里没有，报 node_not_found 那一句。
      expect(result.stderr).toContain('文档里没有 id 为 "hr-nope" 的节点。');
      expect(sha(path)).toBe(before);
    });
  });
});

describe("退出码 1 · 禁用内容", () => {
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

describe("退出码 1 · 片段校验", () => {
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

      // 片段层先拦（`invalid_fragment`，退出码 1）：两个根不可能落进任何容器的一个位置。
      // 这里不再拿"未闭合的 `<div>`"当非法样本——单根片段现在按容错解析收下，落到内容模型那层才算错。
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("片段");
      expect(result.stderr).toContain("根元素");
    });
  });
});

describe("退出码 1 · 风格缺失", () => {
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

describe("退出码 2 · 用法错误", () => {
  it("should exit 2 with the usage when no command is given", async () => {
    const result = checked(await runCli([]));

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("缺少命令：new | normalize | outline | read | patch | check");
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

describe("退出码 3 · IO 与路径", () => {
  it("should exit 3 for a missing file", async () => {
    const result = checked(await runCli(["outline", "missing.html"]));
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("读取时路径不存在");
  });

  it("should exit 3 for ../x.html and never create the target", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      seed(dir);
      // 唯一名：`escape.html` 是多个测试文件共用的固定名，别的用例写歪一次就会把这条带红。
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

describe("退出码 3 · 坏编码", () => {
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

describe("退出码 70 · 内部错误（真触发）", () => {
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

describe("退出码 70 · HR_DEBUG 栈", () => {
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
        // 流错误的 stack 只有首行（无 `at` 帧），但 `--debug` 仍会追加它。
        expect(result.stderr).toContain("EBADF: bad file descriptor, read\nError: EBADF");
      } finally {
        closeSync(fd);
      }
    });
  });
});
