// 这层管：`hr undo` 的**信封与空态**。
//
// 用户视角两件事：
//   1. 有历史时 undo 真的把内容退回去，`--json` 给出 `{path,bytes,restoredFrom,sha256}`；
//   2. 没历史时是一条**可读的空态**（`nothing_to_undo`，退出 1），不是崩栈、不是"静默成功"。

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checked } from "./cli-support";
import { fieldOf, parseJsonLine, runCli, textOf, withTempDir, type CliResult } from "./harness";

const DOC = [
  '<!doctype html><html><body><article data-hr-id="hr-0">',
  '<h1 data-hr-id="hr-a">章标题</h1><p data-hr-id="hr-b">会被删掉的正文。</p>',
  "</article></body></html>",
  "",
].join("\n");

const seed = (dir: string): string => {
  const path = join(dir, "d.html");
  writeFileSync(path, DOC);
  return path;
};

const undo = (dir: string, json = false): Promise<CliResult> =>
  runCli(json ? ["undo", "d.html", "--json"] : ["undo", "d.html"], { cwd: dir });

describe("hr undo · 空态", () => {
  it("should report nothing_to_undo (exit 1) when there is no snapshot", async () => {
    await withTempDir(async (dir) => {
      const path = seed(dir);

      const human = checked(await undo(dir));
      const json = checked(await undo(dir, true));
      const envelope = parseJsonLine(json.stdout);

      expect(human.code).toBe(1);
      expect(human.stdout).toBe("");
      expect(human.stderr.trim()).toBe("没有可撤销的历史快照");
      expect(json.code).toBe(1);
      expect(fieldOf(envelope, "ok")).toBe(false);
      expect(fieldOf(envelope, "code")).toBe("nothing_to_undo");
      // 空态不许动文件。
      expect(readFileSync(path, "utf8")).toBe(DOC);
    });
  });
});

describe("hr undo · 退回上一次改动", () => {
  it("should restore the exact previous bytes and hand the snapshot path back", async () => {
    await withTempDir(async (dir) => {
      const path = seed(dir);
      checked(
        await runCli(["patch", "d.html", "hr-b", "--action", "delete", "--json"], { cwd: dir }),
      );
      expect(readFileSync(path, "utf8")).not.toContain("会被删掉的正文");

      const result = checked(await undo(dir, true));
      const envelope = parseJsonLine(result.stdout);
      const data = fieldOf(envelope, "data");

      expect(result.code).toBe(0);
      expect(fieldOf(envelope, "ok")).toBe(true);
      // 撤完就回到 patch 前那一字节不差的样子（用户手上/编辑器里的那份）。
      expect(readFileSync(path, "utf8")).toBe(DOC);
      expect(fieldOf(data, "bytes")).toBe(Buffer.byteLength(DOC));
      expect(textOf(fieldOf(data, "sha256"))).toMatch(/^[0-9a-f]{64}$/u);
      expect(textOf(fieldOf(data, "restoredFrom"))).toContain(".hreader/history/");
    });
  });
});

describe("hr undo · 第二次撤销没有东西可退", () => {
  it("should be undoable only once per snapshot, then say nothing_to_undo", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      checked(await runCli(["patch", "d.html", "hr-b", "--action", "delete"], { cwd: dir }));

      expect(checked(await undo(dir)).code).toBe(0);
      const second = checked(await undo(dir));

      expect(second.code).toBe(1);
      expect(second.stderr).toContain("没有可撤销的历史快照");
    });
  });
});

describe("hr undo · 人读回执", () => {
  it("should print a one-line human receipt naming the file and its size", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      checked(await runCli(["patch", "d.html", "hr-b", "--action", "delete"], { cwd: dir }));

      const result = checked(await undo(dir));

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toMatch(/^undone .*d\.html \(\d+ bytes, from .+\)\n$/u);
    });
  });
});
