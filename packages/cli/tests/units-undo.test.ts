// 这层管：`hr undo`（M2.3 新命令，裁定 #2）——参数、退出码、两种输出，以及真子进程下"改一次再撤一次"。
// `undo` 是 CLI 侧唯一新增的可写命令，之前零用例（src 里 50% 死码），这里补齐。
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { dataUndo, humanUndo } from "../src/output";
import { run, type CliIo } from "../src/run";
import { checked, DOC, seed, sha } from "./cli-support";
import { keysOf, runCli, withTempDir } from "./harness";

interface Capture {
  readonly io: CliIo;
  readonly out: string[];
  readonly err: string[];
}

const capture = (cwd: string): Capture => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      cwd,
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      readStdin: () => Promise.resolve(new Uint8Array()),
      debug: false,
      launchParentPid: process.ppid,
    },
  };
};

const patchOf = (path: string): readonly string[] => [
  "patch",
  path,
  "hr-c",
  "--action",
  "replace",
  "--html",
  "<p>改过的正文</p>",
];

describe("hr undo · 参数", () => {
  it("should reject a missing <file> with exit 2 and the undo synopsis", async () => {
    const { io, out, err } = capture(process.cwd());
    const code = await run(["undo"], io);

    expect(code).toBe(2);
    expect(out).toEqual([]);
    expect(err.join("")).toContain("undo 缺少 <file>");
    expect(err.join("")).toContain("hr undo <file>");
  });

  it("should reject a second positional argument", async () => {
    const { io, err } = capture(process.cwd());
    const code = await run(["undo", "a.html", "b.html"], io);

    expect(code).toBe(2);
    expect(err.join("")).toContain("undo 只接受 1 个位置参数，多出 1 个");
  });

  it("should reject a flag that undo does not accept", async () => {
    const { io, err } = capture(process.cwd());
    const code = await run(["undo", "a.html", "--selector", "h2"], io);

    expect(code).toBe(2);
    expect(err.join("")).toContain("--selector");
  });
});

describe("hr undo · 真盘与输出", () => {
  it("should keep the file and report nothing_to_undo when there is no history", async () => {
    await withTempDir(async (dir) => {
      const path = seed(dir);
      const before = sha(path);
      const { io, out, err } = capture(dir);

      const code = await run(["undo", "a.html"], io);

      expect(code).toBe(1);
      expect(err.join("")).toContain("没有可回滚的历史快照");
      expect(out).toEqual([]);
      expect(sha(path)).toBe(before);
    });
  });
});

describe("hr undo · 输出与历史", () => {
  it("should print the human line after an undo", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const { io, out } = capture(dir);

      expect(await run(patchOf("a.html"), io)).toBe(0);
      out.length = 0;
      expect(await run(["undo", "a.html"], io)).toBe(0);

      expect(out.join("")).toMatch(/^undone .*a\.html \(\d+ bytes, from .+\)\n$/u);
    });
  });

  it("should print the JSON envelope when --json is given", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const { io, out } = capture(dir);

      expect(await run(patchOf("a.html"), io)).toBe(0);

      out.length = 0;
      expect(await run(["undo", "a.html", "--json"], io)).toBe(0);

      // 键序是契约（`dataUndo` 的字段顺序）：一条正则同时钉住顺序与四个字段的形状。
      expect(out.join("")).toMatch(
        /^\{"path":"[^"]+a\.html","bytes":\d+,"restoredFrom":".+","sha256":"[0-9a-f]{64}"\}.*$/u,
      );
      // `sha256` 必须是"恢复后的盘上字节"的哈希：差一位就说明 undo 没真把原字节写回去。
      expect(out.join("")).toContain(`"sha256":"${sha(join(dir, "a.html"))}"`);
    });
  });
});

describe("hr undo · 真子进程", () => {
  it("should restore the exact bytes of the previous revision", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const before = sha(join(dir, "a.html"));
      checked(await runCli(patchOf("a.html"), { cwd: dir }));
      expect(sha(join(dir, "a.html"))).not.toBe(before);

      const result = checked(await runCli(["undo", "a.html"], { cwd: dir }));

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toMatch(/^undone .*a\.html \(\d+ bytes, from .+\)\n$/u);
      expect(sha(join(dir, "a.html"))).toBe(before);
    });
  });

  it("should exit non-zero and keep the file when undo runs on a file with no history", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "plain.html");
      writeFileSync(path, DOC);
      const before = sha(path);

      const result = checked(await runCli(["undo", "plain.html"], { cwd: dir }));

      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("没有可回滚的历史快照");
      expect(sha(path)).toBe(before);
    });
  });
});

describe("undo 的输出格式（纯函数）", () => {
  const result = { path: "/w/a.html", bytes: 12, restoredFrom: "r1", sha256: "abc" };

  it("should render the human line with path, bytes and source revision", () => {
    expect(humanUndo(result)).toBe("undone /w/a.html (12 bytes, from r1)\n");
  });

  it("should render a JSON object with the four keys in contract order", () => {
    const line = dataUndo(result);

    expect(keysOf(JSON.parse(line))).toEqual(["path", "bytes", "restoredFrom", "sha256"]);
    expect(line.endsWith("\n")).toBe(false);
  });
});
