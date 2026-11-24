// 这层管：`importDocCommand` 的进程内行为（落盘、--out 守卫、--json 键集、人读摘要、错误归口）；不起子进程。

import { existsSync, realpathSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { HrError } from "@hreader/core";

import { importDocCommand, type ImportDocInput } from "../src/commands/import";
import { fieldOf, keysOf, listOf, parseJsonLine, withTempDir } from "./harness";

/** 演示稿式外来 HTML：脚本、事件属性、装饰 div、无 `<article>`——import 的全部路径都要走一遍。 */
const FOREIGN = [
  "<!doctype html><html><head><title>外来演示</title>",
  "<script>window.boot()</script></head>",
  "<body><nav>菜单</nav><main>",
  '<section class="slide"><h1>第一页</h1><p onclick="go()">要点</p></section>',
  '<section class="slide"><h1>第二页</h1><p>收束</p></section>',
  "</main></body></html>",
].join("");

const codeOf = async (run: () => Promise<string>): Promise<string> => {
  try {
    await run();
  } catch (error: unknown) {
    if (error instanceof HrError) return error.code;
    throw error;
  }
  throw new Error("应抛 HrError");
};

/** workspace 用真实路径：`run.ts` 在调命令前已把两侧真实化，命令层拿到的就该是 realpath。 */
const withRealDir = async (run: (dir: string) => Promise<void>): Promise<void> =>
  withTempDir(async (raw) => {
    await run(realpathSync(raw));
  });

const seedForeign = (dir: string, html = FOREIGN): string => {
  const path = join(dir, "deck.html");
  writeFileSync(path, html);
  return path;
};

const inputOf = (dir: string, overrides: Partial<ImportDocInput> = {}): ImportDocInput => ({
  path: join(dir, "deck.html"),
  out: join(dir, "deck.hr.html"),
  docKind: undefined,
  title: undefined,
  workspace: dir,
  force: false,
  json: false,
  displayOut: "deck.hr.html",
  ...overrides,
});

describe("importDocCommand · 落盘与人读摘要", () => {
  it("should write a managed document and print the report summary", async () => {
    await withRealDir(async (dir) => {
      seedForeign(dir);
      const text = await importDocCommand(inputOf(dir));

      const written = readFileSync(join(dir, "deck.hr.html"), "utf8");
      expect(written).toContain('data-hr-id="root" data-hr-kind="note"');
      expect(written).toContain("<section");
      expect(written).not.toContain("<script");
      expect(text).toContain("imported deck.hr.html (note, 2 节");
      expect(text).toContain("标题「外来演示」（<title>）");
      expect(text).toContain("主干：<main>");
      expect(text).toContain("丢弃明细：");
      // head（装 script）与 body 里 <main> 的兄弟 nav 都计入"主干之外"。
      expect(text).toContain("head ×1");
      expect(text).toContain("nav ×1");
      expect(text).toContain("on* ×1");
    });
  });

  it("should take an explicit --kind and --title through to the report", async () => {
    await withRealDir(async (dir) => {
      seedForeign(dir);
      const text = await importDocCommand(inputOf(dir, { docKind: "slides", title: "季度复盘" }));

      const written = readFileSync(join(dir, "deck.hr.html"), "utf8");
      expect(written).toContain('data-hr-kind="slides"');
      expect(text).toContain("imported deck.hr.html (slides, 2 节");
      expect(text).toContain("标题「季度复盘」（--title）");
    });
  });

  it("should label the h1 title source and the body trunk when nothing better exists", async () => {
    await withRealDir(async (dir) => {
      // 无 <main>、两棵子树文本量相等（谁都不是多数）→ body 兜底；无 <title> → 首个 <h1> 供标题。
      writeFileSync(
        join(dir, "deck.html"),
        "<body><section><h1>文档名</h1><p>内容</p></section><section><h1>其它页</h1><p>内容</p></section></body>",
      );
      const text = await importDocCommand(inputOf(dir));

      expect(text).toContain("标题「文档名」（首个 <h1>）");
      expect(text).toContain("主干：<body>");
      expect(text).not.toContain("丢弃明细");
    });
  });

  it("should label the largest trunk and fall back to 未命名 when no title exists", async () => {
    await withRealDir(async (dir) => {
      writeFileSync(
        join(dir, "deck.html"),
        '<body><header>页眉</header><div class="wrap"><p>正文正文正文正文正文正文正文</p></div></body>',
      );
      const text = await importDocCommand(inputOf(dir));

      expect(text).toContain("标题「未命名」（兜底文案）");
      expect(text).toContain("主干：<div>");
    });
  });
});

describe("importDocCommand · --json", () => {
  it("should emit the full report as a single-line envelope with the contract keys", async () => {
    await withRealDir(async (dir) => {
      seedForeign(dir);
      const envelope = parseJsonLine(await importDocCommand(inputOf(dir, { json: true })));
      const data = fieldOf(envelope, "data");
      expect(fieldOf(envelope, "ok")).toBe(true);
      expect(keysOf(data)).toEqual([
        "path",
        "bytes",
        "kind",
        "title",
        "titleSource",
        "trunk",
        "trunkTag",
        "sections",
        "removedElements",
        "strippedAttributes",
        "discarded",
      ]);
      expect(fieldOf(data, "kind")).toBe("note");
      expect(fieldOf(data, "trunk")).toBe("main");
      expect(fieldOf(data, "trunkTag")).toBeNull();
      expect(fieldOf(data, "sections")).toBe(2);
      expect(listOf(fieldOf(data, "discarded")).length).toBeGreaterThan(0);
    });
  });

  it("should quote trunkTag when the largest subtree supplies the trunk", async () => {
    await withRealDir(async (dir) => {
      writeFileSync(
        join(dir, "deck.html"),
        '<body><div class="content"><p>唯一且足够长的正文正文正文正文</p></div><nav>菜单</nav></body>',
      );
      const data = fieldOf(
        parseJsonLine(await importDocCommand(inputOf(dir, { json: true }))),
        "data",
      );
      expect(fieldOf(data, "trunk")).toBe("largest");
      expect(fieldOf(data, "trunkTag")).toBe("div");
    });
  });
});

describe("importDocCommand · --out 守卫与错误归口", () => {
  it("should refuse an existing target without --force", async () => {
    await withRealDir(async (dir) => {
      seedForeign(dir);
      writeFileSync(join(dir, "deck.hr.html"), "已占用");
      const code = await codeOf(() => importDocCommand(inputOf(dir)));

      expect(code).toBe("file_exists");
      // 原目标一个字节都没动。
      expect(readFileSync(join(dir, "deck.hr.html"), "utf8")).toBe("已占用");
    });
  });

  it("should print the real out path when no display name is given", async () => {
    await withRealDir(async (dir) => {
      seedForeign(dir);
      const text = await importDocCommand(inputOf(dir, { displayOut: undefined }));

      expect(text).toContain(`imported ${join(dir, "deck.hr.html")}`);
    });
  });

  it("should overwrite an existing target with --force", async () => {
    await withRealDir(async (dir) => {
      seedForeign(dir);
      writeFileSync(join(dir, "deck.hr.html"), "已占用");
      await importDocCommand(inputOf(dir, { force: true }));

      expect(readFileSync(join(dir, "deck.hr.html"), "utf8")).toContain('data-hr-id="root"');
    });
  });

  it("should reject an out outside the workspace before any write", async () => {
    await withRealDir(async (dir) => {
      seedForeign(dir);
      const code = await codeOf(() =>
        importDocCommand(inputOf(dir, { out: join(dir, "..", "escape.html") })),
      );

      expect(code).toBe("path_outside_workspace");
      expect(existsSync(join(dir, "deck.hr.html"))).toBe(false);
    });
  });

  it("should fail the parent-directory check before existence checks", async () => {
    await withRealDir(async (dir) => {
      seedForeign(dir);
      const code = await codeOf(() =>
        importDocCommand(inputOf(dir, { out: join(dir, "missing", "deck.hr.html") })),
      );

      expect(code).toBe("io_failure");
    });
  });

  it("should report not_a_file when the source does not exist", async () => {
    await withRealDir(async (dir) => {
      const code = await codeOf(() => importDocCommand(inputOf(dir)));

      expect(code).toBe("not_a_file");
    });
  });

  it("should reject an already-managed source", async () => {
    await withRealDir(async (dir) => {
      seedForeign(dir, '<article data-hr-id="hr-a"><h2 data-hr-id="hr-b">标题</h2></article>');
      const code = await codeOf(() => importDocCommand(inputOf(dir)));

      expect(code).toBe("invalid_input");
    });
  });
});
