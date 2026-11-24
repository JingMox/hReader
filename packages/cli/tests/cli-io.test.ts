// 这层管：`--json` 契约、管道/编码、深嵌套回归（全部真子进程）。

import { realpathSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { fieldOf, keysOf, parseJsonLine, runCli, withTempDir } from "./harness";
import { checked, seed, sha } from "./cli-support";

describe("--json 契约", () => {
  it("should keep the frozen key order for patch and expose historyPath", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      seed(dir);
      const result = checked(
        await runCli(
          // 目标是容器 <article>：段落在它的内容模型之内（往 <p> 里 append 段落会被 F6 拒，那是另一条用例的事）。
          ["patch", "a.html", "hr-a", "--action", "append", "--html", "<p>x</p>", "--json"],
          { cwd: dir },
        ),
      );

      expect(result.code).toBe(0);
      const envelope = parseJsonLine(result.stdout);
      expect(keysOf(envelope)).toEqual(["ok", "data"]);
      expect(keysOf(fieldOf(envelope, "data"))).toEqual([
        "path",
        "bytes",
        "newIds",
        "changed",
        "historyPath",
      ]);
    });
  });
});

describe("--json 单行契约", () => {
  it("should emit exactly one newline even when the tone prompt is multi-line", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      seed(dir);
      const result = checked(
        await runCli(["style", "a.html", "--tone", "atelier-editorial", "--json"], { cwd: dir }),
      );

      expect(result.code).toBe(0);
      const envelope = parseJsonLine(result.stdout);
      expect(keysOf(fieldOf(envelope, "data"))).toEqual(["prompt"]);
      expect(fieldOf(fieldOf(envelope, "data"), "prompt")).toContain("\n");
    });
  });

  // 只走一条通道（P2-3）：`--json` 的消费者常把 `2>&1` 当真源，再写一遍 stderr 就多出第二段。
  it("should write a parseable error JSON to stdout and nothing to stderr", async () => {
    const result = checked(await runCli(["outline", "missing.html", "--json"]));

    expect(result.code).toBe(3);
    const envelope = parseJsonLine(result.stdout);
    expect(keysOf(envelope)).toEqual(["ok", "code", "message"]);
    expect(fieldOf(envelope, "ok")).toBe(false);
    expect(fieldOf(envelope, "message")).toContain("读取时路径不存在");
    expect(result.stderr).toBe("");
  });
});

describe("管道与编码 · 成功路径", () => {
  it("should read the fragment from a real pipe", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      seed(dir);
      const result = checked(
        await runCli(["patch", "a.html", "hr-c", "--action", "replace", "--html-stdin", "--json"], {
          cwd: dir,
          stdin: Buffer.from('<p data-hr-id="hr-c">管道</p>'),
        }),
      );

      expect(result.code).toBe(0);
      expect(readFileSync(join(dir, "a.html"), "utf8")).toContain("管道");
    });
  });
});

describe("管道与编码 · 拒绝路径", () => {
  it("should exit 2 for empty stdin", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      seed(dir);
      const result = checked(
        await runCli(["patch", "a.html", "hr-c", "--action", "append", "--html-stdin"], {
          cwd: dir,
          stdin: new Uint8Array(),
        }),
      );

      expect(result.code).toBe(2);
      expect(result.stderr).toContain("--html-stdin 读到的内容为空");
    });
  });
});

describe("管道与编码 · UTF-8 拒绝", () => {
  it("should reject invalid UTF-8 stdin with exit 3 and keep the target bytes", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      const path = seed(dir);
      const before = sha(path);
      const result = checked(
        await runCli(["patch", "a.html", "hr-c", "--action", "append", "--html-stdin", "--json"], {
          cwd: dir,
          stdin: Buffer.from([0xff, 0xfe]),
        }),
      );

      expect(result.code).toBe(3);
      expect(JSON.parse(result.stdout.trim())).toMatchObject({ ok: false, code: "invalid_utf8" });
      expect(sha(path)).toBe(before);
    });
  });

  it("should reject invalid UTF-8 --html-file with exit 3", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      const path = seed(dir);
      writeFileSync(join(dir, "frag.bin"), Buffer.from([0x3c, 0xff]));
      const before = sha(path);
      const result = checked(
        await runCli(["patch", "a.html", "hr-c", "--action", "append", "--html-file", "frag.bin"], {
          cwd: dir,
        }),
      );

      expect(result.code).toBe(3);
      expect(result.stderr).toContain("不是合法 UTF-8");
      expect(sha(path)).toBe(before);
    });
  });
});

describe("深嵌套回归（40k 层不崩）", () => {
  // F10 把 `div` 放进 `ADDRESSABLE_TAGS`，于是“全篇 div 都没 id”= 这份文档还没 normalize（`assertNormalized`）。
  // 所以先把 40k 层落盘 + `normalize --write` 过一遍，再 outline：两段都是活生生的迭代/序列化压力点。
  it("should normalize and outline a 40000-deep document without crashing", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      const deep = `<article>${"<div>".repeat(40_000)}x${"</div>".repeat(40_000)}</article>`;
      writeFileSync(join(dir, "deep.html"), deep);

      const normalized = checked(await runCli(["normalize", "deep.html", "--write"], { cwd: dir }));
      expect(normalized.code).toBe(0);
      // 每个 div（加最外层 article 自身）都该拿到 id：少一个就说明深递归在某层悄悄停了。
      expect(normalized.stdout).toContain("+40001 ids");

      const result = checked(await runCli(["outline", "deep.html", "--json"], { cwd: dir }));
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toMatchObject({ ok: true });
    }, 30_000);
  });
});
