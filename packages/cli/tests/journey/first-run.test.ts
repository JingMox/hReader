// This layer covers the **first-run path** — someone with only handwritten HTML walks from an empty directory to reading in a browser.
//
// The rules (why this card is its own file):
//   · Only public contracts: the commands and args in `--help`, stdout/stderr shapes, exit codes, HTTP routes;
//   · **Never import anything under `src/**`** — spawn the CLI only, then speak HTTP once serve is up;
//   · Assertions say "what the user got" (three chapters in the outline / `<h1>` chapter titles in the
//     exported HTML / visible body text in the page), not "which branch it took".

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checked } from "../cli-support";
import { fieldOf, listOf, parseJsonLine, runCli, textOf, withTempDir } from "../harness";
import { homeOf, startServe } from "../serve-harness";

/** Real user material: a cover + 3 chapters + 1 section, **not one `data-hr-id`**. */
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

/** ① Handwritten draft → inject ids: returns how many were injected (0 means normalize spun idle). */
const normalizeDraft = async (dir: string): Promise<number> => {
  writeFileSync(join(dir, "doc.html"), DRAFT);
  const result = checked(
    await runCli(["normalize", "doc.html", "--write", "--json"], { cwd: dir }),
  );
  expect(result.code).toBe(0);
  return Number(fieldOf(dataOf(result), "injected"));
};

const titleOf = (node: unknown): string => textOf(fieldOf(node, "text"));

/** The outline is a tree (chapters nest in `children`): the "outline" a user sees is the flattened heading sequence. */
const flatten = (nodes: readonly unknown[]): readonly unknown[] =>
  nodes.flatMap((node) => [node, ...flatten(listOf(fieldOf(node, "children")))]);

/** ② Outline: can the user see their three chapters and one section. */
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

/** ③ Read: the whole doc is readable (body included), and a single chapter is locatable too. */
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

/** ④ Patch a chapter: returns patch's envelope `data` (ids unchanged — "old ids still work" is what the user wants). */
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

/** ⑤ Apply a visual style: the command succeeds, and the file really gained theme styles (not only in memory). */
const styleOf = async (dir: string): Promise<void> => {
  const result = checked(
    await runCli(["style", "doc.html", "--visual", "atelier-editorial", "--json"], { cwd: dir }),
  );
  expect(result.code).toBe(0);
  expect(fieldOf(dataOf(result), "changed")).toBe(true);
  expect(readFileSync(join(dir, "doc.html"), "utf8")).toMatch(/<style|class="hr-/u);
};

/** ⑥ Export the printout: returns "the one on disk / the one in the envelope"; the criterion is a really readable HTML reaching the user. */
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

describe("first-run path · fix the handwritten draft's structure before reading", () => {
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

describe("first-run path · patch a chapter, switch style, export the printout", () => {
  it("should let the user edit one chapter, restyle it and export a printable copy", async () => {
    await withTempDir(async (dir) => {
      await normalizeDraft(dir);
      const { chapter2 } = await outlineOf(dir);

      // After the patch: "ids belong to the product" — the new root inherits the target id and **the old id still works**,
      // so this asserts "read the new body back by the old id right away", not "the old id died".
      const replaced = await patchChapter(dir, chapter2);
      expect(listOf(fieldOf(replaced, "replacedIds"))).toEqual([]);
      expect((await readOf(dir, chapter2)).chapter).toContain("第二章 评审：必须与可以");
      expect(readFileSync(join(dir, "doc.html"), "utf8")).toContain("第二章 评审：必须与可以");

      await styleOf(dir);
      const exported = await exportOf(dir);
      expect(exported.bytes).toBe(Buffer.byteLength(exported.printed));
      // The printout must open standalone: chapter titles in `<h1>`s, body text present.
      expect(exported.printed).toMatch(/<h1[^>]*>[\s\S]*?第一章 发布节奏/u);
      expect(exported.printed).toMatch(/<h1[^>]*>[\s\S]*?第三章 下一季度/u);
      expect(exported.printed).toContain("下一季度只做三件事。");
    }, 30_000);
  });
});

describe("first-run path · serve the site and read it in a browser", () => {
  it("should serve the finished document at the URL it printed", async () => {
    await withTempDir(async (dir) => {
      await normalizeDraft(dir);
      // No `--json`: only the line the program prints for humans, `serving … on <url> (pid N)`, is honored.
      const serve = await startServe("doc.html", { json: false, home: homeOf(dir), cwd: dir });
      try {
        // The printed address must carry its credentials: a bare address pasted into a browser is a 401.
        expect(serve.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+$/u);

        // Do what the user does: GET that address verbatim, no self-made cookie/header.
        // The first visit drops the `hr` cookie then 302s back to a clean `/` — a browser would carry it along; here we only use the cookie the response itself gave.
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
        // The front page must have body content (otherwise "opened the page, saw nothing").
        expect(html).toContain("下一季度只做三件事。");

        // Negative: a bare `/` without credentials is a 401 (another page on the same machine must not take the content).
        expect((await fetch(new URL("/", serve.url))).status).toBe(401);
      } finally {
        await serve.stop();
      }
    }, 30_000);
  });
});
