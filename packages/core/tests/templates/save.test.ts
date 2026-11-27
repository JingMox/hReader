// This layer: saveTemplate — extraction of theme CSS + `<stem>_files/` assets into a staged
// template dir, member shape, manifest/guide generation, tier scoping, capacity gates, path
// security and the all-or-nothing staging rename with rollback.

import { describe, expect, it } from "vitest";

import type { HrError } from "../../src/hr-error";
import { classifyDocument, embeddedThemeCssOf, parseHtml } from "../../src";
import { createFromTemplate, readTemplate, saveTemplate } from "../../src/templates";
import { codeOfAsync, systemError } from "../io/harness";
import {
  depsAt,
  fakeFs,
  rootsOf,
  seedDirs,
  type FakeFs,
  HOME,
  USER_TEMPLATES,
  WS,
  WS_TEMPLATES,
} from "./harness";

const errorOf = async (run: () => Promise<unknown>): Promise<HrError> => {
  try {
    await run();
  } catch (error: unknown) {
    return error as HrError;
  }
  throw new Error("expected a throw but none happened");
};

const textOf = (fake: FakeFs, absPath: string): string =>
  new TextDecoder().decode(fake.state.files.get(absPath) ?? new Uint8Array());

const dirOf = (id: string, home = false): string => `${home ? USER_TEMPLATES : WS_TEMPLATES}/${id}`;

const MANAGED_PAGE =
  "<!doctype html>\n" +
  '<html><head><meta charset="utf-8"><title>季度复盘</title>\n' +
  '<style id="hr-theme">body { color: #111 }</style>\n' +
  "<style>.local { a: 1 }</style></head>\n" +
  '<body><article data-hr-id="a1"><h1 data-hr-id="h1">季度复盘</h1>\n' +
  '<section data-hr-id="s1"><h2 data-hr-id="s1-h">关键数据</h2><p>正文</p>\n' +
  '<img src="q3_files/chart.png" srcset="q3_files/s.png 1x, other/x.png 2x" alt="">\n' +
  '<link href="q3_files/extra.css">\n' +
  "</section></article></body></html>\n";

const MANAGED_FILES: Record<string, string> = {
  "/ws/q3.html": MANAGED_PAGE,
  "/ws/q3_files/chart.png": "PNG-CHART",
  "/ws/q3_files/s.png": "PNG-S",
  "/ws/q3_files/extra.css": "CSS-EXTRA",
  "/ws/q3_files/deep/x.bin": "BIN-DEEP",
};

const setup = (files: Record<string, string>, dirs: readonly string[] = []): FakeFs => {
  const fake = fakeFs(files);
  seedDirs(fake, WS, HOME, USER_TEMPLATES, WS_TEMPLATES, `${WS}/.hreader`, ...dirs);
  return fake;
};

const saveAt = async (fake: FakeFs, input: Parameters<typeof saveTemplate>[0], home?: string) =>
  saveTemplate(input, rootsOf(), depsAt(fake, home ?? HOME));

const manifestOf = (fake: FakeFs, dir: string): Record<string, unknown> =>
  JSON.parse(textOf(fake, `${dir}/template.json`)) as Record<string, unknown>;

describe("saveTemplate · happy path", () => {
  it("should extract theme, assets and structure of a managed page into the workspace tier", async () => {
    const fake = setup(MANAGED_FILES, ["/ws/q3_files", "/ws/q3_files/deep"]);

    const result = await saveAt(fake, { file: "q3.html", id: "q3-tpl" });

    const dir = dirOf("q3-tpl");
    expect({ ...result, assets: [...result.assets].sort() }).toEqual({
      id: "q3-tpl",
      dir,
      format: "managed",
      scope: "workspace",
      assets: ["assets/chart.png", "assets/deep/x.bin", "assets/extra.css", "assets/s.png"].sort(),
    });

    const manifest = manifestOf(fake, dir);
    expect(manifest).toEqual({
      id: "q3-tpl",
      name: "q3-tpl",
      description: "从 q3.html 提取的页面模板",
      version: 1,
      format: "managed",
      entry: "index.html",
      style: "style.css",
      guide: "guide.md",
      tags: [],
    });

    const entry = textOf(fake, `${dir}/index.html`);
    // Theme block stays as an empty placeholder; the other <style> survives untouched.
    expect(entry).toContain('<style id="hr-theme"></style>');
    expect(entry).toContain("<style>.local { a: 1 }</style>");
    expect(entry).not.toContain("color: #111");
    // Assets are present and references were rewritten from <stem>_files/ to assets/.
    expect(entry).toContain('src="assets/chart.png"');
    expect(entry).toContain('srcset="assets/s.png 1x, other/x.png 2x"');
    expect(entry).toContain('href="assets/extra.css"');
    expect(entry).not.toContain("q3_files/");
    expect(textOf(fake, `${dir}/style.css`)).toBe("body { color: #111 }");
    expect(textOf(fake, `${dir}/assets/chart.png`)).toBe("PNG-CHART");
    expect(textOf(fake, `${dir}/assets/deep/x.bin`)).toBe("BIN-DEEP");

    const guide = textOf(fake, `${dir}/guide.md`);
    expect(guide).toContain("# q3-tpl");
    expect(guide).toContain("从 `q3.html` 提取的模板（format: managed）");
    expect(guide).toContain("- 季度复盘");
    expect(guide).toContain("  - 关键数据");
    expect(guide).toContain("写作规范（待补充）");
  });

  it("should mark a page without a managed article as format html", async () => {
    const fake = setup({
      "/ws/plain.html": "<html><head><title>P</title></head><body><h1>P</h1><p>x</p></body></html>",
    });

    const result = await saveAt(fake, { file: "plain.html", id: "plain" });

    expect(result.format).toBe("html");
    const manifest = manifestOf(fake, result.dir);
    expect(manifest["format"]).toBe("html");
    // No theme in the source → no style.css member and no style key in the manifest,
    // but the empty placeholder is still minted for later creates.
    expect("style" in manifest).toBe(false);
    expect(fake.state.files.has(`${result.dir}/style.css`)).toBe(false);
    expect(textOf(fake, `${result.dir}/index.html`)).toContain('<style id="hr-theme"></style>');
    // The h1 still lands in the generated outline.
    expect(textOf(fake, `${result.dir}/guide.md`)).toContain("- P");
  });

  it("should honor name/description/style/guide overrides", async () => {
    const fake = setup(MANAGED_FILES, ["/ws/q3_files", "/ws/q3_files/deep"]);

    const result = await saveAt(fake, {
      file: "q3.html",
      id: "custom",
      name: "季度模板",
      description: "复盘专用",
      style: "h1 { font-size: 2em }",
      guide: "# 自定义指南\n写什么都行",
    });

    const dir = result.dir;
    const manifest = manifestOf(fake, dir);
    expect(manifest["name"]).toBe("季度模板");
    expect(manifest["description"]).toBe("复盘专用");
    // Provided style wins over the embedded theme.
    expect(textOf(fake, `${dir}/style.css`)).toBe("h1 { font-size: 2em }");
    expect(textOf(fake, `${dir}/guide.md`)).toBe("# 自定义指南\n写什么都行");
  });

  it("should land in the user tier under deps.home when global is set", async () => {
    const fake = setup({
      "/ws/plain.html": "<html><head><title>P</title></head><body>x</body></html>",
    });

    const result = await saveAt(fake, { file: "plain.html", id: "glob", global: true });

    expect(result.scope).toBe("user");
    expect(result.dir).toBe(dirOf("glob", true));
    expect(fake.state.files.has(`${result.dir}/index.html`)).toBe(true);
    expect(fake.state.dirs.has(dirOf("glob"))).toBe(false);
  });

  it("should truncate an over-long heading in the generated outline", async () => {
    const long = "长".repeat(200);
    const fake = setup({
      "/ws/p.html": `<html><body><h1>${long}</h1></body></html>`,
    });

    const result = await saveAt(fake, { file: "p.html", id: "t" });

    const guide = textOf(fake, `${result.dir}/guide.md`);
    expect(guide).toContain(`${"长".repeat(120)}…`);
    expect(guide).not.toContain(long);
  });

  it("should handle Chinese, emoji and space in the file path and template fields", async () => {
    const fake = setup({
      "/ws/我的 文档/🚀 note.html":
        '<html><head><title>火箭笔记</title></head><body><article data-hr-id="a1"><h1>火箭</h1></article></body></html>',
      "/ws/我的 文档/🚀 note_files/图.png": "IMG",
    });
    seedDirs(fake, "/ws/我的 文档", "/ws/我的 文档/🚀 note_files");

    const result = await saveAt(fake, {
      file: "我的 文档/🚀 note.html",
      id: "rocket-tpl",
      name: "火箭模板 🚀",
    });

    expect(result.format).toBe("managed");
    expect(result.assets).toEqual(["assets/图.png"]);
    expect(manifestOf(fake, result.dir)["name"]).toBe("火箭模板 🚀");
    expect(textOf(fake, `${result.dir}/assets/图.png`)).toBe("IMG");
  });
});

describe("saveTemplate · round-trip", () => {
  it("should produce a template that readTemplate accepts and createFromTemplate reuses", async () => {
    const fake = setup(MANAGED_FILES, ["/ws/q3_files", "/ws/q3_files/deep"]);
    const roots = rootsOf();
    const deps = depsAt(fake);

    await saveTemplate({ file: "q3.html", id: "q3-tpl" }, roots, deps);

    const loaded = await readTemplate("q3-tpl", roots, deps);
    expect(loaded.source).toBe("workspace");
    expect(loaded.manifest.id).toBe("q3-tpl");
    expect(loaded.style).toBe("body { color: #111 }");
    expect([...loaded.assets].sort()).toEqual([
      "assets/chart.png",
      "assets/deep/x.bin",
      "assets/extra.css",
      "assets/s.png",
    ]);

    const created = await createFromTemplate(
      { id: "q3-tpl", target: "new.html", title: "新文档" },
      roots,
      deps,
    );
    expect([...created.assets].sort()).toEqual([
      "new_files/chart.png",
      "new_files/deep/x.bin",
      "new_files/extra.css",
      "new_files/s.png",
    ]);

    const text = textOf(fake, `${WS}/new.html`);
    // The theme is re-inlined; references point back at <stem>_files/.
    expect(embeddedThemeCssOf(text)).toBe("body { color: #111 }");
    expect(text).toContain('src="new_files/chart.png"');
    expect(text).toContain('srcset="new_files/s.png 1x, other/x.png 2x"');
    expect(text).toContain('href="new_files/extra.css"');
    expect(text).not.toContain("assets/");
    expect(classifyDocument(parseHtml(text)).cls).toBe("managed");
    expect(textOf(fake, `${WS}/new_files/deep/x.bin`)).toBe("BIN-DEEP");
  });
});

describe("saveTemplate · input and path gates", () => {
  it("should refuse malformed ids before touching the file", async () => {
    const fake = setup({ "/ws/p.html": "<html></html>" });
    for (const id of ["../x", "a/b", "a\\b", "A", "a b", "", "-a", "a".repeat(65)]) {
      expect(await codeOfAsync(() => saveAt(fake, { file: "p.html", id }))).toBe("invalid_input");
    }
    expect(fake.state.dirs.has(`${WS_TEMPLATES}/x`)).toBe(false);
  });

  it("should refuse non-HTML sources, missing files and path escapes", async () => {
    const fake = setup({
      "/ws/p.txt": "not html",
      "/outside/evil.html": "<html></html>",
      "/ws/sub/../p.html": "<html></html>",
      "/ws/.hreader/t/index.html": "<html></html>",
    });
    seedDirs(fake, "/ws/sub", "/ws/.hreader/t");

    expect(await codeOfAsync(() => saveAt(fake, { file: "p.txt", id: "t" }))).toBe("invalid_input");
    expect(await codeOfAsync(() => saveAt(fake, { file: "missing.html", id: "t" }))).toBe(
      "not_a_file",
    );
    expect(await codeOfAsync(() => saveAt(fake, { file: "../outside/evil.html", id: "t" }))).toBe(
      "path_outside_workspace",
    );
    expect(await codeOfAsync(() => saveAt(fake, { file: "/outside/evil.html", id: "t" }))).toBe(
      "path_outside_workspace",
    );
    expect(await codeOfAsync(() => saveAt(fake, { file: ".hreader/t/index.html", id: "t" }))).toBe(
      "path_outside_workspace",
    );
  });

  it("should accept a .htm source file too", async () => {
    const fake = setup({ "/ws/p.htm": "<html><body>x</body></html>" });

    const result = await saveAt(fake, { file: "p.htm", id: "t" });

    expect(result.format).toBe("html");
  });

  it("should surface invalid UTF-8 verbatim and a raw source-read failure as io_failure", async () => {
    const fake = setup({ "/ws/p.html": "<html><body>x</body></html>" });
    fake.state.files.set("/ws/bad.html", Uint8Array.from([0xff, 0xfe, 0x41]));

    // The HrError from decodeUtf8 passes through instead of being re-wrapped.
    expect(await codeOfAsync(() => saveAt(fake, { file: "bad.html", id: "t1" }))).toBe(
      "invalid_utf8",
    );

    fake.fail("readFile", systemError("EIO"), (path: string) => path === "/ws/p.html");
    expect(await codeOfAsync(() => saveAt(fake, { file: "p.html", id: "t2" }))).toBe("io_failure");
  });

  it("should wrap an asset read failure as io_failure", async () => {
    const fake = setup(
      {
        "/ws/p.html": "<html><body>x</body></html>",
        "/ws/p_files/a.png": "PNG",
      },
      ["/ws/p_files"],
    );
    fake.fail("readFile", systemError("EIO"), (path: string) => path === "/ws/p_files/a.png");

    const error = await errorOf(() => saveAt(fake, { file: "p.html", id: "t" }));
    expect(error.code).toBe("io_failure");
  });

  it("should refuse a source file that is a symlink escaping the workspace", async () => {
    const fake = setup({ "/outside/evil.html": "<html></html>" });
    fake.state.links.set("/ws/link.html", "/outside/evil.html");

    const error = await errorOf(() => saveAt(fake, { file: "link.html", id: "t" }));
    expect(error.code).toBe("path_outside_workspace");
  });

  it("should refuse blank name/description and unsafe provided style", async () => {
    const fake = setup({ "/ws/p.html": "<html><body>x</body></html>" });
    const base = { file: "p.html", id: "t" };

    expect(await codeOfAsync(() => saveAt(fake, { ...base, name: "   " }))).toBe("invalid_input");
    expect(await codeOfAsync(() => saveAt(fake, { ...base, description: " \t " }))).toBe(
      "invalid_input",
    );
    // `</style><script>` inside provided CSS must fail the same gate createFromTemplate applies.
    expect(
      await codeOfAsync(() =>
        saveAt(fake, { ...base, style: "a{}</style><script>alert(1)</script>" }),
      ),
    ).toBe("invalid_theme");
    expect(
      await codeOfAsync(() => saveAt(fake, { ...base, style: "@import 'https://evil/x.css';" })),
    ).toBe("invalid_theme");
    // Nothing was written for any of the refused calls.
    expect([...fake.state.dirs].some((dir) => dir.startsWith(`${WS_TEMPLATES}/t`))).toBe(false);
  });

  it("should return file_exists when the target dir or a same-named file exists", async () => {
    const fake = setup({ "/ws/p.html": "<html><body>x</body></html>" });
    seedDirs(fake, dirOf("taken"));

    expect(await codeOfAsync(() => saveAt(fake, { file: "p.html", id: "taken" }))).toBe(
      "file_exists",
    );

    // A regular file at the target path is a taken slot too.
    fake.state.files.set(dirOf("file-taken"), new Uint8Array([1]));
    expect(await codeOfAsync(() => saveAt(fake, { file: "p.html", id: "file-taken" }))).toBe(
      "file_exists",
    );
  });

  it("should map a non-ENOENT lstat failure on the target slot to io_failure", async () => {
    const fake = setup({ "/ws/p.html": "<html><body>x</body></html>" });
    fake.fail("lstat", systemError("EIO"), (path: string) => path === dirOf("t"));

    expect(await codeOfAsync(() => saveAt(fake, { file: "p.html", id: "t" }))).toBe("io_failure");
  });

  it("should treat an ENOTDIR probe on the target slot as free", async () => {
    const fake = setup({ "/ws/p.html": "<html><body>x</body></html>" });
    fake.fail("lstat", systemError("ENOTDIR"), (path: string) => path === dirOf("t"));

    const result = await saveAt(fake, { file: "p.html", id: "t" });
    expect(result.id).toBe("t");
  });

  it("should refuse a <stem>_files path that is a regular file", async () => {
    const fake = setup({
      "/ws/p.html": "<html><body>x</body></html>",
      "/ws/p_files": "NOT-A-DIR",
    });

    const error = await errorOf(() => saveAt(fake, { file: "p.html", id: "t" }));
    expect(error.code).toBe("invalid_input");
    expect(error.message).toContain("p_files");
  });

  it("should refuse an assets dir or member that resolves outside", async () => {
    const fake = setup(
      {
        "/ws/p.html": "<html><body>x</body></html>",
        "/outside/evil.txt": "E",
      },
      ["/ws/p_files"],
    );
    // Case 1: the assets dir itself links out.
    fake.state.links.set("/ws/p_files", "/outside");
    seedDirs(fake, "/outside");
    expect(await codeOfAsync(() => saveAt(fake, { file: "p.html", id: "t1" }))).toBe(
      "path_outside_workspace",
    );

    // Case 2: a member inside a real dir links out.
    fake.state.links.delete("/ws/p_files");
    fake.state.links.set("/ws/p_files/hole.txt", "/outside/evil.txt");
    const error = await errorOf(() => saveAt(fake, { file: "p.html", id: "t2" }));
    expect(error.code).toBe("invalid_input");
    expect(error.message).toContain("hole.txt");
  });

  it("should follow a <stem>_files symlink that stays inside the workspace", async () => {
    const fake = setup(
      {
        "/ws/p.html": "<html><body>x</body></html>",
        "/ws/real-assets/a.png": "PNG",
      },
      ["/ws/real-assets"],
    );
    fake.state.links.set("/ws/p_files", "/ws/real-assets");

    const result = await saveAt(fake, { file: "p.html", id: "t" });
    expect(result.assets).toEqual(["assets/a.png"]);
    expect(textOf(fake, `${result.dir}/assets/a.png`)).toBe("PNG");
  });

  it("should collect member links resolving inside the assets dir and skip link cycles", async () => {
    const fake = setup(
      {
        "/ws/p.html": "<html><body>x</body></html>",
        "/ws/p_files/real.png": "PNG",
      },
      ["/ws/p_files"],
    );
    // An alias that resolves to a sibling member is collected under its own lexical name.
    fake.state.links.set("/ws/p_files/alias.png", "/ws/p_files/real.png");
    // A cycle back into the assets dir is skipped instead of descending forever.
    fake.state.links.set("/ws/p_files/loop", "/ws/p_files");

    const result = await saveAt(fake, { file: "p.html", id: "t" });
    expect([...result.assets].sort()).toEqual(["assets/alias.png", "assets/real.png"]);
    expect(textOf(fake, `${result.dir}/assets/alias.png`)).toBe("PNG");
  });

  it("should map a re-stat failure on a resolved member link to io_failure", async () => {
    const fake = setup(
      {
        "/ws/p.html": "<html><body>x</body></html>",
        "/ws/p_files/real.png": "PNG",
      },
      ["/ws/p_files"],
    );
    fake.state.links.set("/ws/p_files/alias.png", "/ws/p_files/real.png");
    fake.fail("lstat", systemError("EIO"), (path: string) => path === "/ws/p_files/real.png");

    const error = await errorOf(() => saveAt(fake, { file: "p.html", id: "t" }));
    expect(error.code).toBe("io_failure");
  });

  it("should refuse a member link whose realpath cannot be resolved", async () => {
    const fake = setup(
      {
        "/ws/p.html": "<html><body>x</body></html>",
        "/ws/p_files/a.png": "PNG",
      },
      ["/ws/p_files"],
    );
    fake.state.links.set("/ws/p_files/dangling.png", "/ws/nowhere.png");

    const error = await errorOf(() => saveAt(fake, { file: "p.html", id: "t" }));
    expect(error.code).toBe("invalid_input");
    expect(error.message).toContain("无法解析的资源成员路径");
  });

  it("should refuse a member that is neither a file nor a directory nor a resolvable link", async () => {
    const fake = setup(
      {
        "/ws/p.html": "<html><body>x</body></html>",
        "/ws/p_files/real.png": "PNG",
      },
      ["/ws/p_files"],
    );
    fake.state.links.set("/ws/p_files/alias.png", "/ws/p_files/real.png");
    // The link resolves inside, but the re-stat of the target still reports a link —
    // fake fs cannot produce that shape, so wrap lstat for this one path.
    const deps = depsAt(fake);
    const linkStat = {
      isFile: () => false,
      isSymbolicLink: () => true,
      mtimeMs: 0,
      size: 0,
    };
    const fs = {
      ...deps.fs,
      lstat: (path: string) =>
        path === "/ws/p_files/real.png" ? Promise.resolve(linkStat) : deps.fs.lstat(path),
    };

    const error = await errorOf(() =>
      saveTemplate({ file: "p.html", id: "t" }, rootsOf(), { ...deps, fs }),
    );
    expect(error.code).toBe("invalid_input");
    expect(error.message).toContain("非常规文件");
  });

  it("should map resource-collection fs failures to io_failure", async () => {
    const fake = setup(
      {
        "/ws/p.html": "<html><body>x</body></html>",
        "/ws/p_files/a.png": "PNG",
      },
      ["/ws/p_files"],
    );

    fake.fail("lstat", systemError("EIO"), (path: string) => path === "/ws/p_files");
    expect(await codeOfAsync(() => saveAt(fake, { file: "p.html", id: "t1" }))).toBe("io_failure");

    fake.fail("realpath", systemError("EIO"), (path: string) => path === "/ws/p_files");
    expect(await codeOfAsync(() => saveAt(fake, { file: "p.html", id: "t2" }))).toBe("io_failure");

    fake.fail("readdir", systemError("EIO"), (path: string) => path === "/ws/p_files");
    expect(await codeOfAsync(() => saveAt(fake, { file: "p.html", id: "t3" }))).toBe("io_failure");

    fake.fail("lstat", systemError("EIO"), (path: string) => path === "/ws/p_files/a.png");
    expect(await codeOfAsync(() => saveAt(fake, { file: "p.html", id: "t4" }))).toBe("io_failure");
  });

  it("should treat an ENOTDIR probe on the assets dir as no assets", async () => {
    const fake = setup({ "/ws/p.html": "<html><body>x</body></html>" }, ["/ws/p_files"]);
    fake.fail("lstat", systemError("ENOTDIR"), (path: string) => path === "/ws/p_files");

    const result = await saveAt(fake, { file: "p.html", id: "t" });
    expect(result.assets).toEqual([]);
  });
});

describe("saveTemplate · capacity gates", () => {
  it("should refuse when the asset count exceeds the file cap", async () => {
    const files: Record<string, string> = { "/ws/p.html": "<html><body>x</body></html>" };
    for (let index = 0; index < 1001; index += 1) {
      files[`/ws/p_files/a${String(index).padStart(4, "0")}.bin`] = "x";
    }
    const fake = setup(files, ["/ws/p_files"]);

    const error = await errorOf(() => saveAt(fake, { file: "p.html", id: "t" }));
    expect(error.code).toBe("invalid_input");
    expect(error.message).toContain("1000");
  });

  it("should refuse when the total size exceeds the byte cap", async () => {
    const fake = setup(
      {
        "/ws/p.html": "<html><body>x</body></html>",
        "/ws/p_files/big.bin": "x".repeat(20 * 1024 * 1024 + 1),
      },
      ["/ws/p_files"],
    );

    const error = await errorOf(() => saveAt(fake, { file: "p.html", id: "t" }));
    expect(error.code).toBe("invalid_input");
  });

  it("should refuse when the staged members tip the count over the file cap", async () => {
    // 998 assets still fit under the collection cap; manifest + entry + guide push it over.
    const files: Record<string, string> = { "/ws/p.html": "<html><body>x</body></html>" };
    for (let index = 0; index < 998; index += 1) {
      files[`/ws/p_files/a${String(index).padStart(4, "0")}.bin`] = "x";
    }
    const fake = setup(files, ["/ws/p_files"]);

    const error = await errorOf(() => saveAt(fake, { file: "p.html", id: "t" }));
    expect(error.code).toBe("invalid_input");
    expect(error.message).toContain("页面与资源");
  });

  it("should refuse when the staged members tip the total over the byte cap", async () => {
    // One asset exactly at the byte cap passes collection; the template members push it over.
    const fake = setup(
      {
        "/ws/p.html": "<html><body>x</body></html>",
        "/ws/p_files/big.bin": "x".repeat(20 * 1024 * 1024),
      },
      ["/ws/p_files"],
    );

    const error = await errorOf(() => saveAt(fake, { file: "p.html", id: "t" }));
    expect(error.code).toBe("invalid_input");
    expect(error.message).toContain("页面与资源");
  });
});

describe("saveTemplate · atomic publish", () => {
  const stagingLeftovers = (fake: FakeFs): string[] =>
    [...fake.state.dirs, ...fake.state.files.keys()].filter((path) =>
      path.includes(".hr-template-save-"),
    );

  it("should remove the staging dir when a member write fails mid-way", async () => {
    const fake = setup(MANAGED_FILES, ["/ws/q3_files", "/ws/q3_files/deep"]);
    // Fail on an asset write so rollback has to recurse into the staged assets/ dir.
    fake.fail("writeFile", systemError("ENOSPC"), (path: string) => path.includes("/assets/"));

    expect(await codeOfAsync(() => saveAt(fake, { file: "q3.html", id: "q3-tpl" }))).toBe(
      "io_failure",
    );
    expect(stagingLeftovers(fake)).toEqual([]);
    expect(fake.state.dirs.has(dirOf("q3-tpl"))).toBe(false);
  });

  it("should survive the cleanup readdir failing when rollback runs", async () => {
    const fake = setup({ "/ws/p.html": "<html><body>x</body></html>" });
    // The entry write fails; the cleanup readdir on the staging dir fails too — rollback
    // just returns instead of letting the sweep failure mask the write error.
    fake.fail("writeFile", systemError("ENOSPC"), (path: string) =>
      path.includes(".hr-template-save-"),
    );
    fake.fail("readdir", systemError("EIO"), (path: string) => path.includes(".hr-template-save-"));

    expect(await codeOfAsync(() => saveAt(fake, { file: "p.html", id: "t" }))).toBe("io_failure");
  });

  it("should continue rollback past a member whose stat fails", async () => {
    const fake = setup({ "/ws/p.html": "<html><body>x</body></html>" });
    // The second staged member (index.html) fails to write; while sweeping, the manifest's
    // stat fails too — rollback must skip it instead of aborting on the cleanup path.
    fake.fail("writeFile", systemError("ENOSPC"), (path: string) => path.endsWith("index.html"));
    fake.fail(
      "lstat",
      systemError("EIO"),
      (path: string) => path.includes(".hr-template-save-") && path.endsWith("template.json"),
    );

    expect(await codeOfAsync(() => saveAt(fake, { file: "p.html", id: "t" }))).toBe("io_failure");
  });

  it("should remove the staging dir when the self-check fails", async () => {
    const fake = setup({ "/ws/p.html": "<html><body>x</body></html>" });
    // Make the staged manifest unreadable at inspect time → the dir fails its own gate.
    fake.fail("readFile", systemError("ENOENT"), (path: string) =>
      path.includes(".hr-template-save-"),
    );

    expect(await codeOfAsync(() => saveAt(fake, { file: "p.html", id: "t" }))).toBe(
      "invalid_template",
    );
    expect(stagingLeftovers(fake)).toEqual([]);
  });

  it("should map a rename race to file_exists and clean the staging dir", async () => {
    const fake = setup({ "/ws/p.html": "<html><body>x</body></html>" });
    fake.fail("rename", systemError("EEXIST"), (path: string) =>
      path.includes(".hr-template-save-"),
    );

    expect(await codeOfAsync(() => saveAt(fake, { file: "p.html", id: "t" }))).toBe("file_exists");
    expect(stagingLeftovers(fake)).toEqual([]);
  });

  it("should surface a non-race rename failure as io_failure", async () => {
    const fake = setup({ "/ws/p.html": "<html><body>x</body></html>" });
    fake.fail("rename", systemError("EIO"), (path: string) => path.includes(".hr-template-save-"));

    expect(await codeOfAsync(() => saveAt(fake, { file: "p.html", id: "t" }))).toBe("io_failure");
    expect(stagingLeftovers(fake)).toEqual([]);
  });
});
