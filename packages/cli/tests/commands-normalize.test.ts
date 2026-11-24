// 这层管：`normalize` / `undo` 的编排与人读回执，以及 `outline` 的诊断行走 `warn`；
// 真 fs + 真 core，不跑子进程。

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { normalizeCommand } from "../src/commands/normalize";
import { outlineCommand } from "../src/commands/outline";
import { patchCommand } from "../src/commands/patch";
import { undoCommand } from "../src/commands/undo";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "hr-cmd-norm-")));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const DOC = [
  '<article data-hr-id="hr-a"><h2 data-hr-id="hr-b">标题</h2>',
  '<p data-hr-id="hr-c">正文一</p></article>',
].join("\n");

const fileOf = (name: string, html: string): string => {
  const path = join(dir, name);
  writeFileSync(path, html);
  return path;
};

const jsonOf = (text: string): unknown => JSON.parse(text.trim());

describe("undoCommand", () => {
  it("should print the human line after one patch and say nothing_to_undo the second time", async () => {
    fileOf("u1.html", DOC);
    await patchCommand({
      path: "u1.html",
      nodeId: "hr-c",
      action: "replace",
      html: "<p>改过的正文</p>",
      workspace: dir,
      json: false,
    });

    // `undo` 与 `patch` 同一口径：文件按 workspace 相对路径给。
    const human = await undoCommand({ path: "u1.html", workspace: dir, json: false });
    expect(human).toMatch(/^undone .*u1\.html \(\d+ bytes, from /u);
    // 一份快照只能退一次：第二回得说“没东西可退”，不能假装成功。
    await expect(
      undoCommand({ path: "u1.html", workspace: dir, json: false }),
    ).rejects.toMatchObject({
      code: "nothing_to_undo",
    });
  });
});

const DRAFT = "<article><h1>第一章</h1><p>正文。</p></article>";

describe("normalizeCommand · 仅打印", () => {
  it("should print the normalized html itself when --write is not given", async () => {
    const path = fileOf("n1.html", DRAFT);
    const printed = await normalizeCommand({
      path: "n1.html",
      workspace: dir,
      write: false,
      json: false,
    });

    // `hr normalize a.html > b.html` 要逐字节可用：stdout 就是结果，不多补换行。
    expect(printed).toContain('data-hr-id="');
    expect(printed).not.toMatch(/\n$/u);
    expect(readFileSync(path, "utf8")).toBe(DRAFT);
  });
});

describe("normalizeCommand · --write", () => {
  it("should report needsNormalize:false and the injected count on --write --json", async () => {
    const path = fileOf("n2.html", DRAFT);
    const parsed = jsonOf(
      await normalizeCommand({ path: "n2.html", workspace: dir, write: true, json: true }),
    );

    expect(parsed).toMatchObject({ ok: true, data: { needsNormalize: false } });
    expect(
      Number(Reflect.get(Object(Reflect.get(Object(parsed), "data")), "injected")),
    ).toBeGreaterThan(0);
    expect(readFileSync(path, "utf8")).toContain('data-hr-id="');
  });

  it("should say unchanged on the human --write line when the document is already normalized", async () => {
    fileOf("n3.html", DOC);
    const human = await normalizeCommand({
      path: "n3.html",
      workspace: dir,
      write: true,
      json: false,
    });

    expect(human).toMatch(/^unchanged .*n3\.html \(\d+ bytes，已带齐 data-hr-id\)\n$/u);
  });

  it("should say normalized with the injected count on the human --write line", async () => {
    fileOf("n4.html", DRAFT);
    const human = await normalizeCommand({
      path: "n4.html",
      workspace: dir,
      write: true,
      json: false,
    });

    // 用户关心的是"到底补了几个 id"：只回一句"好了"没法判断是不是白写了一遍盘。
    expect(human).toMatch(/^normalized .*n4\.html \(\+[1-9]\d* ids, \d+ bytes\)\n$/u);
  });
});

describe("outlineCommand · 诊断行", () => {
  it("should hand each diagnostic to warn as one human line instead of swallowing it", async () => {
    // 把 `hr-meta` 手改坏：大纲仍能出，但要带一条解析诊断（人读模式得看得到，不能只在 --json 里有）。
    const path = fileOf(
      "o4.html",
      [
        "<!doctype html><html><head>",
        // 批注块被手改坏了：这是用户会真的遇到的那类诊断（不是造出来的分支）。
        '<script id="hr-meta">{不是 JSON}</script>',
        '</head><body><article data-hr-id="hr-a"><h1 data-hr-id="hr-b">一</h1>',
        '<p data-hr-id="hr-c">正文</p></article></body></html>',
      ].join("\n"),
    );
    const rows: string[] = [];

    const printed = await outlineCommand({ path, json: false, warn: (row) => rows.push(row) });

    expect(rows.length).toBeGreaterThan(0);
    // 钉住"针对坏 meta"这个症状：任何一条无关诊断都能满足 `[a-z_]+: .+`，等于没锁。
    expect(rows[0]).toMatch(/^(warning|error): .*hr-meta/u);
    // 诊断走 warn，不抿进 stdout 的正文：stdout 还得是能直接拼的大纲。
    expect(printed).not.toContain(rows[0]);
  });
});
