// 这层管：`hr export` 的真子进程行为（stdout/落盘/--json/错误码/外部图片提示）；不碰网络、不起 Chrome。

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { fieldOf, keysOf, parseJsonLine, runCli, withTempDir } from "./harness";

const LIMIT = 4 * 1024 * 1024;

const ARTICLE = [
  "<!doctype html><html><head><title>导出样张</title></head><body>",
  '<article data-hr-id="doc">',
  "<h1>导出样张</h1>",
  '<section data-hr-id="s1"><h2>第一节</h2><p>正文一。</p></section>',
  '<section data-hr-id="s2"><h2>第二节</h2><p>正文二。</p>',
  '<img src="https://cdn.example/x.png" alt="外链">',
  '<p><button class="hr-toc-toggle">目录</button>可裁的界面元素。</p>',
  "</section>",
  "</article></body></html>",
].join("\n");

const seed = (dir: string): string => {
  const path = join(dir, "doc.html");
  writeFileSync(path, ARTICLE);
  return path;
};

const dataFieldOf = (result: { readonly stdout: string }, key: string): unknown =>
  fieldOf(fieldOf(parseJsonLine(result.stdout), "data"), key);

/** 成功信封的键集是**精确**契约（docs/05）：`ok`+`data`（四个键），不多不少。 */
const expectSuccessKeysOf = (result: { readonly stdout: string }): void => {
  const envelope = parseJsonLine(result.stdout);
  expect(keysOf(envelope)).toEqual(["ok", "data"]);
  expect(keysOf(fieldOf(envelope, "data"))).toEqual(["html", "bytes", "droppedImages", "out"]);
};

describe("hr export · stdout", () => {
  it("should print the printable html to stdout and keep sentences", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const result = await runCli(["export", "doc.html", "--workspace", dir], { cwd: dir });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("<!DOCTYPE html>");
      expect(result.stdout).toContain("正文二。");
    });
  });

  it("should drop ui nodes and warn about removed external images on stderr", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const result = await runCli(["export", "doc.html", "--workspace", dir], { cwd: dir });
      // 类名会出现在 CSS 的 `@media print` 防御块里，只断 DOM：没有 `<button` 才算真删掉。
      expect(result.stdout).not.toContain("<button");
      expect(result.stdout).not.toContain("cdn.example");
      expect(result.stderr).toBe("已移除 1 个外部图片\n");
    });
  });

  it("should keep stdout free of the warning when nothing was dropped", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "clean.html"), "<article><h1>干净</h1><p>一句。</p></article>");
      const result = await runCli(["export", "clean.html", "--workspace", dir], { cwd: dir });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
    });
  });
});

describe("hr export · 纸张", () => {
  it("should always print on a4 regardless of any pdf page-size flag", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const result = await runCli(["export", "doc.html", "--workspace", dir], { cwd: dir });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("size: A4;");
      expect(result.stdout).not.toContain("size: A5;");
    });
  });
});

describe("hr export · --json", () => {
  it("should report bytes equal to the html's byte length", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const result = await runCli(["export", "doc.html", "--json", "--workspace", dir], {
        cwd: dir,
      });
      const html = String(dataFieldOf(result, "html"));
      expect(dataFieldOf(result, "bytes")).toBe(Buffer.byteLength(html, "utf8"));
      expect(dataFieldOf(result, "droppedImages")).toBe(1);
      expect(dataFieldOf(result, "out")).toBeNull();
      expectSuccessKeysOf(result);
    });
  });

  it("should emit exactly ok/data/code/message on failure", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "empty.html"), "<article><section></section></article>");
      const result = await runCli(["export", "empty.html", "--json", "--workspace", dir], {
        cwd: dir,
      });
      expect(result.code).toBe(1);
      expect(keysOf(parseJsonLine(result.stdout))).toEqual(["ok", "code", "message"]);
    });
  });

  it("should reject an unknown flag before any rendering", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const result = await runCli(["export", "doc.html", "--nope", "--workspace", dir], {
        cwd: dir,
      });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("未知参数：--nope");
    });
  });
});

describe("hr export · --out", () => {
  it("should map a missing --out parent dir to io_failure (exit 3)", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const result = await runCli(
        ["export", "doc.html", "--out", "out/print.html", "--json", "--workspace", dir],
        { cwd: dir },
      );
      expect(result.code).toBe(3);
      expect(fieldOf(parseJsonLine(result.stdout), "code")).toBe("io_failure");
      expect(existsSync(join(dir, "out/print.html"))).toBe(false);
    });
  });
});

describe("hr export · file_exists 与 --force", () => {
  it("should refuse an existing --out with a --force hint (exit 1)", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      writeFileSync(join(dir, "print.html"), "旧内容");
      const result = await runCli(
        ["export", "doc.html", "--out", "print.html", "--json", "--workspace", dir],
        { cwd: dir },
      );
      expect(result.code).toBe(1);
      expect(fieldOf(parseJsonLine(result.stdout), "code")).toBe("file_exists");
      expect(String(fieldOf(parseJsonLine(result.stdout), "message"))).toContain("--force");
      expect(readFileSync(join(dir, "print.html"), "utf8")).toBe("旧内容");
    });
  });

  it("should overwrite an existing --out under --force", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      writeFileSync(join(dir, "print.html"), "旧内容");
      const result = await runCli(
        ["export", "doc.html", "--out", "print.html", "--force", "--workspace", dir],
        { cwd: dir },
      );
      expect(result.code).toBe(0);
      expect(readFileSync(join(dir, "print.html"), "utf8")).toContain("<!DOCTYPE html>");
    });
  });
});

describe("hr export · --out 成功路径", () => {
  it("should write inside the workspace and leave no tmp file behind", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const result = await runCli(
        ["export", "doc.html", "--out", "print.html", "--json", "--workspace", dir],
        { cwd: dir },
      );
      expect(result.code).toBe(0);
      expect(dataFieldOf(result, "bytes")).toBe(statSync(join(dir, "print.html")).size);
      expect(readFileSync(join(dir, "print.html"), "utf8")).toContain("<!DOCTYPE html>");
      expect(existsSync(join(dir, ".hr-tmp.keep"))).toBe(false);
    });
  });
});

describe("hr export · 错误码", () => {
  it("should map an empty document to empty_document (exit 1)", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "empty.html"), "<article><section></section></article>");
      const result = await runCli(["export", "empty.html", "--json", "--workspace", dir], {
        cwd: dir,
      });
      expect(result.code).toBe(1);
      expect(fieldOf(parseJsonLine(result.stdout), "code")).toBe("empty_document");
    });
  });

  it("should map an unknown visual to unknown_style", async () => {
    await withTempDir(async (dir) => {
      seed(dir);
      const result = await runCli(
        ["export", "doc.html", "--visual", "no-such-visual", "--json", "--workspace", dir],
        { cwd: dir },
      );
      expect(result.code).toBe(1);
      expect(fieldOf(parseJsonLine(result.stdout), "code")).toBe("unknown_style");
    });
  });
});

describe("hr export · 4 MiB 上限", () => {
  it("should reject a product one byte over the 4 MiB limit", async () => {
    await withTempDir(async (dir) => {
      // 上限按产物**最终字节**判（`>` 才拒）：量尺与正稿同名（docId 进产物），否则差值混进文件名长度。
      const measure = async (pad: number): Promise<number> => {
        writeFileSync(
          join(dir, "measure.html"),
          `<article><h1>大稿</h1><p>${"a".repeat(pad)}</p></article>`,
        );
        const result = await runCli(["export", "measure.html", "--json", "--workspace", dir], {
          cwd: dir,
        });
        return Number(dataFieldOf(result, "bytes"));
      };
      const offset = await measure(1);
      writeFileSync(
        join(dir, "measure.html"),
        `<article><h1>大稿</h1><p>${"a".repeat(1 + (LIMIT + 1 - offset))}</p></article>`,
      );
      const result = await runCli(
        ["export", "measure.html", "--out", "over-print.html", "--json", "--workspace", dir],
        { cwd: dir },
      );
      expect(result.code).toBe(1);
      expect(fieldOf(parseJsonLine(result.stdout), "code")).toBe("invalid_input");
      expect(existsSync(join(dir, "over-print.html"))).toBe(false);
    });
  }, 120_000);

  it("should reject a missing source file", async () => {
    await withTempDir(async (dir) => {
      const result = await runCli(["export", "missing.html", "--json", "--workspace", dir], {
        cwd: dir,
      });
      expect(result.code).toBe(3);
      expect(fieldOf(parseJsonLine(result.stdout), "code")).toBe("not_a_file");
    });
  });
});
