// 这层管：**首用路径**——一个只有手写 HTML 的人，从空目录一路走到浏览器里能读。
//
// 规矩（这张卡的分家理由）：
//   · 只用公开契约：`--help` 里的命令与参数、stdout/stderr 形状、退出码、HTTP 路由；
//   · **不 import 任何 `src/**`**——只 spawn CLI，serve 起来后发 HTTP；
//   · 断言写"用户拿到了什么"（大纲里有三章 / 导出的 HTML 里 `<h1>` 是章标题 / 页面里能看到正文），
//     不写"走了哪个分支"。

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checked } from "../cli-support";
import { fieldOf, listOf, parseJsonLine, runCli, textOf, withTempDir } from "../harness";
import { homeOf, startServe } from "../serve-harness";

/** 用户真实原料：封面 + 3 章 + 1 节，**一个 `data-hr-id` 都没有**。 */
const DRAFT = [
  "<!doctype html>",
  '<html lang="zh-CN"><head><meta charset="utf-8"><title>季度复盘</title></head>',
  "<body>",
  '<header class="cover"><h1>季度复盘</h1><p>2026 Q1 · 工程组</p></header>',
  "<article>",
  "<h1>第一章 发布节奏</h1>",
  "<p>这一章讲我们怎么把发布节奏拉回来。</p>",
  "<h2>1.1 回滚路径</h2>",
  "<p>先把回滚路径跑通，再谈加速。</p>",
  "<h1>第二章 评审</h1>",
  "<p>评审拆成必须与可以两类。</p>",
  "<h1>第三章 下一季度</h1>",
  "<p>下一季度只做三件事。</p>",
  "</article>",
  "</body></html>",
  "",
].join("\n");

interface Outline {
  readonly titles: readonly string[];
  readonly chapter2: string;
  readonly wordCount: number;
}

const dataOf = (result: { readonly stdout: string }): unknown =>
  fieldOf(parseJsonLine(result.stdout), "data");

/** ① 手写稿 → 补 id：返回注入了几个（0 就说明 normalize 空转了）。 */
const normalizeDraft = async (dir: string): Promise<number> => {
  writeFileSync(join(dir, "doc.html"), DRAFT);
  const result = checked(
    await runCli(["normalize", "doc.html", "--write", "--json"], { cwd: dir }),
  );
  expect(result.code).toBe(0);
  return Number(fieldOf(dataOf(result), "injected"));
};

const titleOf = (node: unknown): string => textOf(fieldOf(node, "text"));

/** 大纲是树（章节嵌在 `children` 里）：用户眼里的"大纲"是摊平后的标题序列。 */
const flatten = (nodes: readonly unknown[]): readonly unknown[] =>
  nodes.flatMap((node) => [node, ...flatten(listOf(fieldOf(node, "children")))]);

/** ② 大纲：用户能不能看见自己的三章与一节。 */
const outlineOf = async (dir: string): Promise<Outline> => {
  const result = checked(await runCli(["outline", "doc.html", "--json"], { cwd: dir }));
  expect(result.code).toBe(0);
  const nodes = flatten(listOf(fieldOf(dataOf(result), "nodes")));
  const chapter2 = nodes.find((node) => titleOf(node) === "第二章 评审");
  return {
    titles: nodes.map(titleOf),
    chapter2: textOf(fieldOf(chapter2, "id")),
    wordCount: Number(fieldOf(dataOf(result), "wordCount")),
  };
};

/** ③ 读：整篇能读（含正文），单章也能定位到。 */
const readOf = async (
  dir: string,
  chapterId: string,
): Promise<{ all: string; chapter: string }> => {
  const all = checked(await runCli(["read", "doc.html", "article", "--json"], { cwd: dir }));
  const chapter = checked(await runCli(["read", "doc.html", chapterId, "--json"], { cwd: dir }));
  expect(all.code).toBe(0);
  expect(chapter.code).toBe(0);
  return {
    all: textOf(fieldOf(dataOf(all), "html")),
    chapter: textOf(fieldOf(dataOf(chapter), "html")),
  };
};

/** ④ 改一章：返回 patch 的信封 `data`（id 不变，「旧 id 还能用」才是用户要的那件事）。 */
const patchChapter = async (dir: string, oldId: string): Promise<unknown> => {
  const result = checked(
    await runCli(
      [
        "patch",
        "doc.html",
        oldId,
        "--action",
        "replace",
        "--html",
        "<h1>第二章 评审：必须与可以</h1>",
        "--json",
      ],
      { cwd: dir },
    ),
  );
  expect(result.code).toBe(0);
  return dataOf(result);
};

/** ⑤ 上一套视觉风格：命令成功，且文件里真的落进了主题样式（不是只在内存里改）。 */
const styleOf = async (dir: string): Promise<void> => {
  const result = checked(
    await runCli(["style", "doc.html", "--visual", "atelier-editorial", "--json"], { cwd: dir }),
  );
  expect(result.code).toBe(0);
  expect(fieldOf(dataOf(result), "changed")).toBe(true);
  expect(readFileSync(join(dir, "doc.html"), "utf8")).toMatch(/<style|class="hr-/u);
};

/** ⑥ 导出打印稿：返回"盘上那份 / 信封里那份"，判据是用户真的拿到一份能读的 HTML。 */
const exportOf = async (dir: string): Promise<{ printed: string; bytes: number }> => {
  const result = checked(
    await runCli(["export", "doc.html", "--out", "print.html", "--json"], { cwd: dir }),
  );
  expect(result.code).toBe(0);
  return {
    printed: readFileSync(join(dir, "print.html"), "utf8"),
    bytes: Number(fieldOf(dataOf(result), "bytes")),
  };
};

describe("首用路径 · 手写稿先补齐结构再读", () => {
  it("should let a handwritten draft be normalized, outlined and read", async () => {
    // Four sequential CLI spawns fit the default deadline idle, but not under
    // CPU contention — the deadline only guards a real hang (each spawn has
    // its own runCli kill timer), so it gets the headroom the serve case uses.
    await withTempDir(async (dir) => {
      expect(await normalizeDraft(dir)).toBeGreaterThan(0);

      const outline = await outlineOf(dir);
      expect(outline.titles).toContain("第一章 发布节奏");
      expect(outline.titles).toContain("1.1 回滚路径");
      expect(outline.titles).toContain("第三章 下一季度");
      expect(outline.wordCount).toBeGreaterThan(0);

      const read = await readOf(dir, outline.chapter2);
      expect(read.all).toContain("评审拆成必须与可以两类");
      expect(read.all).toContain("下一季度只做三件事。");
      expect(read.all).toContain("data-hr-id=");
      expect(read.chapter).toContain("第二章 评审");
    }, 30_000);
  });
});

describe("首用路径 · 改一章、换风格、出打印稿", () => {
  it("should let the user edit one chapter, restyle it and export a printable copy", async () => {
    await withTempDir(async (dir) => {
      await normalizeDraft(dir);
      const { chapter2 } = await outlineOf(dir);

      // 改完：「id 归产品所有」——新根继承目标 id，**旧 id 仍然可用**，
      // 所以这里断言的是「拿旧 id 立刻读回新正文」，而不是「旧 id 已失效」。
      const replaced = await patchChapter(dir, chapter2);
      expect(listOf(fieldOf(replaced, "replacedIds"))).toEqual([]);
      expect((await readOf(dir, chapter2)).chapter).toContain("第二章 评审：必须与可以");
      expect(readFileSync(join(dir, "doc.html"), "utf8")).toContain("第二章 评审：必须与可以");

      await styleOf(dir);
      const exported = await exportOf(dir);
      expect(exported.bytes).toBe(Buffer.byteLength(exported.printed));
      // 打印稿要能独立打开：章标题在 `<h1>` 里，正文也在。
      expect(exported.printed).toMatch(/<h1[^>]*>[\s\S]*?第一章 发布节奏/u);
      expect(exported.printed).toMatch(/<h1[^>]*>[\s\S]*?第三章 下一季度/u);
      expect(exported.printed).toContain("下一季度只做三件事。");
    }, 30_000);
  });
});

describe("首用路径 · 起站点在浏览器里读", () => {
  it("should serve the finished document at the URL it printed", async () => {
    await withTempDir(async (dir) => {
      await normalizeDraft(dir);
      // 不带 `--json`：只认程序印给人看的那一行 `serving … on <url> (pid N)`。
      const serve = await startServe("doc.html", { json: false, home: homeOf(dir), cwd: dir });
      try {
        // 印出来的那串必须自带凭据：裸地址粘进浏览器就是 401。
        expect(serve.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+$/u);

        // 照用户的做法：把那串地址原样 GET，不带任何自造的 cookie / header。
        // 首访落 `hr` cookie 后 302 回干净的 `/`——浏览器会自动带回去，这里只用响应自己给的 cookie。
        const first = await fetch(serve.url, { redirect: "manual" });
        expect(first.status).toBe(302);
        expect(first.headers.get("location")).toBe("/");
        const setCookie = first.headers.get("set-cookie") ?? "";
        expect(setCookie).toMatch(/^hr=[\w-]+; HttpOnly; SameSite=Strict/u);

        const page = await fetch(new URL("/", serve.url), {
          headers: { cookie: setCookie.split(";")[0] ?? "" },
        });
        const html = await page.text();
        expect(page.status).toBe(200);
        expect(html).toContain("doc.html");
        // 首页必须有正文（不然"打开首页看不到内容"）。
        expect(html).toContain("下一季度只做三件事。");

        // 反面：裸 `/` 没凭据就是 401（同一台机器上别的网页不能拿走正文）。
        expect((await fetch(new URL("/", serve.url))).status).toBe(401);
      } finally {
        await serve.stop();
      }
    }, 30_000);
  });
});
