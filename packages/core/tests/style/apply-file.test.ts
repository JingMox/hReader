// 这层管：`applyStyle` 的落盘编排——锁、原子写、幂等与失败不留痕；用假 fs 复现每一种故障。

import { describe, expect, it } from "vitest";

import { applyStyle } from "../../src/style/apply-file";
import { sha1Of } from "../io/harness";
import { loadStyle } from "../../src/style/load";
import {
  builtinSeed,
  PROJECT_STYLE,
  STYLE_YAML,
  styleEnv,
  USER_STYLE,
  USER_THEME,
} from "./harness";

const FILE = "/work/article.html";

const DOC = [
  '<!doctype html>\r\n<html><head><meta charset="utf-8">',
  '<style id="hr-theme">:root{--hr-old:1}</style>',
  "</head><body><p>别动我。</p></body></html>",
  "",
].join("\r\n");

const seed = (extra: Record<string, string> = {}): Record<string, string> => ({
  ...builtinSeed(".a{color:#1b1a17}\n"),
  [FILE]: DOC,
  ...extra,
});

const htmlOf = (env: ReturnType<typeof styleEnv>): string =>
  new TextDecoder().decode(env.fake.state.files.get(FILE) ?? new Uint8Array());

const styleBytes = (html: string): string =>
  html.slice(html.indexOf(">", html.indexOf("<style")) + 1, html.indexOf("</style>"));

describe("applyStyle · 字节保真", () => {
  it("should replace only the theme block and keep all other bytes", async () => {
    const env = styleEnv(seed());
    const before = htmlOf(env);
    const result = await applyStyle(
      { workspace: "/work", file: "article.html", visualId: "atelier-editorial" },
      env.deps,
    );
    const after = htmlOf(env);

    expect(result).toEqual({
      path: FILE,
      bytes: new TextEncoder().encode(after).length,
      changed: true,
    });
    expect(styleBytes(after)).toBe(".a{color:#1b1a17}\n");
    expect(after.replace(styleBytes(after), "")).toBe(before.replace(styleBytes(before), ""));
    expect(after).toContain("<p>别动我。</p>");
  });
});

describe("applyStyle · 幂等与插入", () => {
  it("should be idempotent: second apply reports changed:false without writing", async () => {
    const env = styleEnv(seed());
    await applyStyle(
      { workspace: "/work", file: "article.html", visualId: "atelier-editorial" },
      env.deps,
    );
    const afterFirst = env.fake.state.files.get(FILE);
    const writesAfterFirst = env.fake.state.log.filter((line) =>
      line.startsWith("writeFileAtomic:"),
    ).length;
    const result = await applyStyle(
      { workspace: "/work", file: "article.html", visualId: "atelier-editorial" },
      env.deps,
    );

    expect(result.changed).toBe(false);
    expect(env.fake.state.files.get(FILE)).toBe(afterFirst);
    expect(
      env.fake.state.log.filter((line) => line.startsWith("writeFileAtomic:")),
    ).toHaveLength(writesAfterFirst);
  });

  it("should insert the block into <head> when the document has none", async () => {
    const bare = "<html><head></head><body><p>x</p></body></html>";
    const env = styleEnv(seed({ [FILE]: bare }));
    const result = await applyStyle(
      { workspace: "/work", file: "article.html", visualId: "atelier-editorial" },
      env.deps,
    );

    expect(result.changed).toBe(true);
    expect(htmlOf(env)).toBe(
      '<html><head><style id="hr-theme">.a{color:#1b1a17}\n</style></head><body><p>x</p></body></html>',
    );
  });
});

describe("applyStyle · 失败不留痕（tmp / 原字节 / 锁）", () => {
  it("should leave no tmp and keep the original bytes when the atomic write fails", async () => {
    const env = styleEnv(seed());
    const before = new Uint8Array(env.fake.state.files.get(FILE) ?? new Uint8Array());
    env.fake.fail("writeFileAtomic", Object.assign(new Error("EIO"), { code: "EIO" }));

    await expect(
      applyStyle(
        { workspace: "/work", file: "article.html", visualId: "atelier-editorial" },
        env.deps,
      ),
    ).rejects.toMatchObject({ code: "io_failure" });
    expect(env.fake.state.files.get(FILE)).toEqual(before);
    expect([...env.fake.state.files.keys()].filter((path) => path.includes(".hr-tmp."))).toEqual(
      [],
    );
    expect(env.fake.state.files.has(`/work/.hreader/locks/${sha1Of("article.html")}.lock`)).toBe(
      false,
    );
  });
});

describe("applyStyle · 锁与静态防线", () => {
  it("should report locked and not write when another live process holds the lock", async () => {
    const lockPath = `/work/.hreader/locks/${sha1Of("article.html")}.lock`;
    const env = styleEnv(seed());
    env.fake.state.dirs.add(`/work/.hreader/locks`);
    env.fake.state.files.set(
      lockPath,
      new TextEncoder().encode(
        JSON.stringify({ pid: process.pid, nonce: "n", at: env.deps.clock.now().getTime() }),
      ),
    );
    const before = new Uint8Array(env.fake.state.files.get(FILE) ?? new Uint8Array());

    await expect(
      applyStyle(
        { workspace: "/work", file: "article.html", visualId: "atelier-editorial" },
        env.deps,
        {
          lockTimeoutMs: 100,
        },
      ),
    ).rejects.toMatchObject({ code: "locked" });
    expect(env.fake.state.files.get(FILE)).toEqual(before);
  });
});

describe("applyStyle · 主题校验失败不留痕", () => {
  it("should surface invalid_theme and unknown_style without touching the document", async () => {
    const env = styleEnv({
      ...seed(),
      "/work/styles/atelier-editorial/theme.css": "@import 'x.css';",
    });
    const before = new Uint8Array(env.fake.state.files.get(FILE) ?? new Uint8Array());

    await expect(
      applyStyle(
        { workspace: "/work", file: "article.html", visualId: "atelier-editorial" },
        env.deps,
      ),
    ).rejects.toMatchObject({ code: "invalid_theme" });
    await expect(
      applyStyle({ workspace: "/work", file: "article.html", visualId: "nope-theme" }, env.deps),
    ).rejects.toMatchObject({ code: "unknown_style" });
    expect(env.fake.state.files.get(FILE)).toEqual(before);
  });
});

describe("applyStyle · 路径与读取失败", () => {
  it("should refuse a target outside the workspace and not create it", async () => {
    const env = styleEnv(seed());

    await expect(
      applyStyle(
        { workspace: "/work", file: "../x.html", visualId: "atelier-editorial" },
        env.deps,
      ),
    ).rejects.toMatchObject({ code: "path_outside_workspace" });
    expect(env.fake.state.files.has("/x.html")).toBe(false);
  });
});

describe("applyStyle · 文档读取失败", () => {
  it("should map a document read failure to io_failure", async () => {
    const env = styleEnv(seed());
    env.fake.fail(
      "readFile",
      Object.assign(new Error("EACCES"), { code: "EACCES" }),
      (path) => path === FILE,
    );

    await expect(
      applyStyle(
        { workspace: "/work", file: "article.html", visualId: "atelier-editorial" },
        env.deps,
      ),
    ).rejects.toMatchObject({ code: "io_failure" });
  });

  it("should reject a non-UTF-8 document instead of writing bytes back", async () => {
    const env = styleEnv(seed());
    env.fake.state.files.set(FILE, new Uint8Array([0xff, 0xfe, 0x3c, 0x68]));

    await expect(
      applyStyle(
        { workspace: "/work", file: "article.html", visualId: "atelier-editorial" },
        env.deps,
      ),
    ).rejects.toMatchObject({ code: "invalid_utf8" });
    expect(env.fake.state.files.get(FILE)).toEqual(new Uint8Array([0xff, 0xfe, 0x3c, 0x68]));
  });
});

describe("resolveStyle 单一解析链", () => {
  it("should apply a builtin visual that loadStyle can resolve", async () => {
    const env = styleEnv(seed());
    const loaded = await loadStyle({ id: "atelier-editorial" }, env.deps);
    const result = await applyStyle(
      { workspace: "/work", file: "article.html", visualId: loaded.spec.id },
      env.deps,
    );

    expect(loaded.source).toBe("builtin");
    expect(result.changed).toBe(true);
  });
});

describe("resolveStyle 单一解析链 · 用户路径", () => {
  it("should apply a user style that loadStyle resolves from an explicit path", async () => {
    const env = styleEnv(
      seed({
        [USER_STYLE("quiet")]: STYLE_YAML("quiet"),
        [USER_THEME("quiet")]: ":root{--hr-bg:#000}",
      }),
    );
    const loaded = await loadStyle({ path: USER_STYLE("quiet") }, env.deps);
    const result = await applyStyle(
      { workspace: "/work", file: "article.html", visualId: loaded.spec.id },
      env.deps,
    );

    expect(loaded.source).toBe("explicit");
    expect(loaded.spec.id).toBe("quiet");
    expect(result.changed).toBe(true);
    expect(htmlOf(env)).toContain(":root{--hr-bg:#000}");
  });

  it("should not report unknown_style for a project style that loadStyle resolves", async () => {
    const env = styleEnv(
      seed({
        [PROJECT_STYLE]: STYLE_YAML("proj-style"),
      }),
    );
    const loaded = await loadStyle({ id: "proj-style" }, env.deps);

    await expect(
      applyStyle({ workspace: "/work", file: "article.html", visualId: loaded.spec.id }, env.deps),
    ).resolves.toMatchObject({ changed: true });
  });
});
