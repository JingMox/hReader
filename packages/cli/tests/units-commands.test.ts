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

  it("should reject a handwritten document with needs_normalize (no silent empty outline)", async () => {
    const path = fileOf("o3.html", "<article><h2>标题</h2></article>");

    // 用户视角：大纲空了却不说“为什么”，看起来像“文档没标题”；这里必须指向唯一的下一步。
    await expect(outlineCommand({ path, json: true })).rejects.toMatchObject({
      code: "needs_normalize",
    });
    await expect(outlineCommand({ path, json: false })).rejects.toThrow(
      /缺少 data-hr-id，先跑 hr normalize .*o3\.html --write/u,
    );
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

  it("should reject a document without any ids (needs_normalize, same code as outline)", async () => {
    const path = fileOf("r4.html", "<article><p>x</p></article>");
    await expect(
      readCommand({ path, target: "p", maxBytes: undefined, json: true }),
    ).rejects.toMatchObject({ code: "needs_normalize" });
  });
});

describe("patchCommand", () => {
  it("should write an append and report changed true with a history path", async () => {
    fileOf("p1.html", DOC);
    const text = await patchCommand({
      path: "p1.html",
      // 目标换成容器 <article>：往 <p>（hr-d）里 append 段落会被 F6 拒（内容模型冲突），
      // 而这条用例只关心“写入成功且回报 changed/newIds/historyPath”。
      nodeId: "hr-a",
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

    // replace 后 id 由内容派生 ⇒ 旧 id 失效；人读行必须把“旧 → 新”写出来，否则用户拿着旧 id 继续调。
    expect(text).toMatch(/^patched .*p2\.html \(\d+ bytes, id 变更: hr-c → hr-[0-9a-f]{8}\)\n$/u);
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

  it("should fall back to its own path when no display path is supplied", async () => {
    fileOf("s5.html", DOC);
    const human = await styleCommand({
      path: "s5.html",
      mode: { kind: "visual", id: DEFAULT_STYLE_ID },
      workspace: dir,
      json: false,
    });

    // 命令层拿不到用户写的那个相对串（只有分发层知道）：退路是结果自己的路径，且一样要印出来。
    expect(human).toContain("s5.html");
    expect(human).toMatch(/^styled .+s5\.html \(\d+ bytes\)\n$/u);
  });
});

describe("styleCommand · visual 的 id 校验", () => {
  it("should refuse a tone id on --visual (B-16：两套 id 空间)", async () => {
    fileOf("s4.html", DOC);

    // 把语言基调 id 交给 `--visual` 会静默换错主题，所以要在应用前就拦住并指着剩下的那条路。
    await expect(
      styleCommand({
        path: "s4.html",
        mode: { kind: "visual", id: "feynman-tech" },
        workspace: dir,
        json: false,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("should surface a malformed visual id as invalid_style instead of treating it as unknown", async () => {
    fileOf("s6.html", DOC);

    // `--visual "Bad Id!"` 连形状都不合法：这不是"找不到主题"，而是 id 本身就写错了（后手完全不同）。
    await expect(
      styleCommand({
        path: "s6.html",
        mode: { kind: "visual", id: "Bad Id!" },
        workspace: dir,
        json: false,
      }),
    ).rejects.toMatchObject({ code: "invalid_style" });
  });
});

describe("styleCommand · visual 的未知 id", () => {
  it("should let an unknown id through to applyStyle instead of guessing", async () => {
    fileOf("s5.html", DOC);

    // 既不是 visual 也不是 tone：不在这里抢答，交给 applyStyle 报它自己的 `unknown_style`。
    await expect(
      styleCommand({
        path: "s5.html",
        mode: { kind: "visual", id: "no-such-theme" },
        workspace: dir,
        json: false,
      }),
    ).rejects.toMatchObject({ code: "unknown_style" });
  });
});
