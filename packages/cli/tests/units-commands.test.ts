// 这层管：四个 command 的编排（文件 → core → 文本/JSON）；真 fs + 真 core，不跑子进程。
//
// 坑：workspace 与 cwd 在 core 里是 realpath 的，而 `--workspace` 是用户原文；
// macOS 的 /tmp → /private/tmp 会让两者不一致（见报告的"真实发现"），所以这里一律用 realpath。

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { DEFAULT_STYLE_ID } from "@hreader/core";

import { outlineCommand } from "../src/commands/outline";
import { patchCommand } from "../src/commands/patch";
import { readCommand } from "../src/commands/read";
import { styleCommand } from "../src/commands/style";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "hr-cmd-")));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 带 id 的文档：`outline`/`patch` 都只认已存在的 `data-hr-id`。 */
const DOC = [
  "<!doctype html>",
  "<html><head><title>t</title></head><body>",
  '<article data-hr-id="hr-a"><h2 data-hr-id="hr-b">标题</h2>',
  '<p data-hr-id="hr-c">正文一</p><p data-hr-id="hr-d">正文二</p></article>',
  "</body></html>",
].join("\n");

const fileOf = (name: string, html: string): string => {
  const path = join(dir, name);
  writeFileSync(path, html);
  return path;
};

/** 断言 JSON 形状（`toMatchObject` 对数组是长度严格的，所以顺便断"只有这些"）。 */
const jsonOf = (text: string): unknown => JSON.parse(text.trim());

describe("outlineCommand", () => {
  it("should print the human outline tree", async () => {
    const path = fileOf("o1.html", DOC);
    expect(await outlineCommand({ path, json: false })).toBe("- hr-b  标题  (2w)\n");
  });

  it("should wrap the Outline in the ok envelope for --json", async () => {
    const path = fileOf("o2.html", DOC);
    expect(jsonOf(await outlineCommand({ path, json: true }))).toMatchObject({
      ok: true,
      data: { nodes: [{ id: "hr-b" }] },
    });
  });

  it("should degrade to an empty outline when ids are missing (warning diagnostic)", async () => {
    const path = fileOf("o3.html", "<article><h2>标题</h2></article>");
    const text = await outlineCommand({ path, json: true });

    expect(text).toContain('"outline_node_without_id"');
    expect(text).toContain('"nodes":[]');
  });
});

describe("readCommand", () => {
  it("should return the node html and the ids it reports", async () => {
    const path = fileOf("r1.html", DOC);
    const text = await readCommand({ path, target: "h2", maxBytes: undefined, json: true });

    expect(text).toContain("标题");
    expect(text).toContain('"ids":["hr-b"]');
  });

  it("should apply --max-bytes to the human output", async () => {
    const path = fileOf("r2.html", DOC);
    const text = await readCommand({ path, target: "article", maxBytes: 80, json: false });

    expect(text.endsWith("\n")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(81);
  });

  it("should honour a valid --max-bytes (readNode with a limit)", async () => {
    const path = fileOf("r2.html", DOC);
    const text = await readCommand({ path, target: "hr-a", maxBytes: 4000, json: false });

    expect(text).toContain("正文一");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("should reject an over-small --max-bytes (invalid_max_bytes)", async () => {
    const path = fileOf("r3.html", DOC);
    await expect(
      readCommand({ path, target: "article", maxBytes: 1, json: false }),
    ).rejects.toMatchObject({ code: "invalid_max_bytes" });
  });

  it("should inject ids for a document without any and report both", async () => {
    const path = fileOf("r4.html", "<article><p>x</p></article>");
    const text = await readCommand({ path, target: "p", maxBytes: undefined, json: true });
    expect(text).toMatch(/"ids":\["hr-[^"]+"\]/u);
    expect(text).toContain("data-hr-id=");
  });
});

describe("patchCommand", () => {
  it("should write an append and report changed true with a history path", async () => {
    fileOf("p1.html", DOC);
    const text = await patchCommand({
      path: "p1.html",
      nodeId: "hr-d",
      action: "append",
      html: "<p>新</p>",
      workspace: dir,
      json: true,
    });

    expect(text).toContain(`"path":"${join(dir, "p1.html")}"`);
    expect(text).toContain('"changed":true');
    expect(text).toContain(".hreader/history/");
    expect(text).toMatch(/"newIds":\["[^"]+"\]/u);
  });

  it("should print the human patched line", async () => {
    fileOf("p2.html", DOC);
    const text = await patchCommand({
      path: "p2.html",
      nodeId: "hr-c",
      action: "replace",
      html: '<p data-hr-id="hr-c">改</p>',
      workspace: dir,
      json: false,
    });

    expect(text).toMatch(/^patched .*p2\.html \(\d+ bytes, \+\d+ ids\)\n$/u);
  });
});

describe("patchCommand · 失败面", () => {
  it("should reject an unknown node id (node_not_found)", async () => {
    fileOf("p3.html", DOC);
    await expect(
      patchCommand({
        path: "p3.html",
        nodeId: "hr-nope",
        action: "delete",
        html: undefined,
        workspace: dir,
        json: false,
      }),
    ).rejects.toMatchObject({ code: "node_not_found" });
  });
});

describe("styleCommand", () => {
  it("should compile the tone prompt (json and human)", async () => {
    fileOf("s1.html", DOC);
    const parsed = await styleCommand({
      path: "s1.html",
      mode: { kind: "tone", id: DEFAULT_STYLE_ID },
      workspace: dir,
      json: true,
    });
    const human = await styleCommand({
      path: "s1.html",
      mode: { kind: "tone", id: DEFAULT_STYLE_ID },
      workspace: dir,
      json: false,
    });

    expect(parsed).toContain('"prompt":"');
    expect(parsed).toContain("atelier");
    expect(human).toContain("atelier");
    expect(human.endsWith("\n")).toBe(true);
  });
});

describe("styleCommand · lint", () => {
  it("should lint with the default style vocabulary (json and human)", async () => {
    fileOf(
      "s2.html",
      '<article data-hr-id="hr-a"><p data-hr-id="hr-c">总而言之，赋能与抓手</p></article>',
    );
    const parsed = await styleCommand({
      path: "s2.html",
      mode: { kind: "lint" },
      workspace: dir,
      json: true,
    });
    const human = await styleCommand({
      path: "s2.html",
      mode: { kind: "lint" },
      workspace: dir,
      json: false,
    });

    expect(parsed).toMatch(/"hits":\[\{"path":"[^"]+","word":"总而言之"/u);
    expect(parsed).toContain('"word":"赋能"');
    expect(parsed).toContain('"word":"抓手"');
    expect(human).toContain("总而言之");
  });
});

describe("styleCommand · visual", () => {
  it("should apply the builtin theme and be idempotent (changed true then false)", async () => {
    fileOf("s3.html", DOC);
    const first = await styleCommand({
      path: "s3.html",
      mode: { kind: "visual", id: DEFAULT_STYLE_ID },
      workspace: dir,
      json: true,
    });
    const again = await styleCommand({
      path: "s3.html",
      mode: { kind: "visual", id: DEFAULT_STYLE_ID },
      workspace: dir,
      json: true,
    });

    expect(first).toContain('"changed":true');
    expect(again).toContain('"changed":false');
  });
});
