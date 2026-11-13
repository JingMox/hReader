// 这层管：history 保留上限（10 份）与裁剪顺序、同毫秒 seq、undo 逐级回退；不测字节保真。

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { nodePatchDeps, patchFile, undoPatch } from "../../src/io";
import { DOC_FILE } from "./fixtures";
import {
  codeOfAsync,
  historyDirAt,
  mkdirAt,
  historyNamesOf,
  readBytesAt,
  sha256Of,
  withWorkspace,
  writeTextAt,
  namesInOrEmpty,
} from "./harness";

const AT = Date.parse("2026-03-04T05:06:07.008Z");
const STAMP = new Date(AT).toISOString();

/** 固定时钟：12 次写入落在同一毫秒，seq 是唯一能区分快照的键。 */
const deps = {
  fs: nodePatchDeps.fs,
  clock: { now: () => new Date(AT) },
  sleep: nodePatchDeps.sleep,
};

const seqOf = (name: string): number => {
  const matched = /-(\d+)\.html$/u.exec(name);
  if (matched === null) throw new Error(`历史文件名不合规：${name}`);
  const [, raw] = matched;
  return Number(raw);
};

const appendOnce = (dir: string, index: number): ReturnType<typeof patchFile> =>
  patchFile(
    {
      workspace: dir,
      file: DOC_FILE,
      request: { targetId: "box", action: "append", html: `<p>第${String(index)}段</p>` },
    },
    deps,
  );

describe("history · 12 次写入只留 10 份", () => {
  it("should prune the two oldest snapshots and keep the newest ten", async () => {
    await withWorkspace(async (dir) => {
      const file = join(dir, DOC_FILE);
      await writeTextAt(
        file,
        '<article data-hr-id="root"><section data-hr-id="box"></section></article>',
      );
      const states = [sha256Of(await readBytesAt(file))];
      const historyDir = await historyDirAt(dir, DOC_FILE);
      await mkdirAt(historyDir);
      await writeTextAt(join(historyDir, "notes.txt"), "非快照文件不能被裁掉");
      for (let index = 1; index <= 12; index += 1) {
        await appendOnce(dir, index);
        states.push(sha256Of(await readBytesAt(file)));
      }
      const names = await historyNamesOf(dir, DOC_FILE);
      const seqs = names
        .filter((name) => name.endsWith(".html"))
        .map(seqOf)
        .sort((left, right) => left - right);

      expect(seqs).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      const newestName = names.find((name) => name.endsWith(`${STAMP}-12.html`));
      expect(newestName).toBeDefined();
      expect(names.some((name) => name.endsWith(`${STAMP}-2.html`))).toBe(false);
      expect(names.some((name) => name.endsWith(`${STAMP}-1.html`))).toBe(false);
      expect(names).toContain("notes.txt");
      const newest = await readBytesAt(join(historyDir, newestName ?? "missing.html"));
      expect(sha256Of(newest)).toBe(states[11] ?? "<missing>");
    });
  });
});

describe("history · undo 两次回到第 11 次之前", () => {
  it("should step back one snapshot per undo and delete what it consumed", async () => {
    await withWorkspace(async (dir) => {
      const file = join(dir, DOC_FILE);
      await writeTextAt(
        file,
        '<article data-hr-id="root"><section data-hr-id="box"></section></article>',
      );
      const states = [sha256Of(await readBytesAt(file))];
      for (let index = 1; index <= 12; index += 1) {
        await appendOnce(dir, index);
        states.push(sha256Of(await readBytesAt(file)));
      }
      const first = await undoPatch({ workspace: dir, file: DOC_FILE }, deps);
      expect(sha256Of(await readBytesAt(file))).toBe(states[11] ?? "<missing>");
      expect(first.restoredFrom.endsWith(`${STAMP}-12.html`)).toBe(true);
      const second = await undoPatch({ workspace: dir, file: DOC_FILE }, deps);
      expect(sha256Of(await readBytesAt(file))).toBe(states[10] ?? "<missing>");
      expect(second.restoredFrom.endsWith(`${STAMP}-11.html`)).toBe(true);
      const names = await historyNamesOf(dir, DOC_FILE);
      expect(names).toHaveLength(8);
      expect(names.some((name) => name.endsWith(`${STAMP}-3.html`))).toBe(true);
    });
  });
});

describe("history · 目录不存在即没有快照", () => {
  it("should create the directory on first write and report undo_unavailable before it", async () => {
    await withWorkspace(async (dir) => {
      const file = join(dir, DOC_FILE);
      await writeTextAt(file, '<article data-hr-id="root"><p data-hr-id="p1">x</p></article>');
      expect(await namesInOrEmpty(await historyDirAt(dir, DOC_FILE))).toEqual([]);
      const code = await codeOfAsync(() => undoPatch({ workspace: dir, file: DOC_FILE }, deps));
      expect(code).toBe("undo_unavailable");
      expect(await namesInOrEmpty(await historyDirAt(dir, DOC_FILE))).toEqual([]);
    });
  });
});
