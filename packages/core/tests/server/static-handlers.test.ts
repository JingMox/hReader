// 这层管：**新接口的静态响应**——`GET /`、`/assets/**`、`/api/theme`、`/api/theme/<id>`。
// 全部走真实文件系统（`mkdtemp`）与真 `styleDeps`，不在假 fs 上断言路径拼接。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HrError } from "../../src/hr-error";
import { createAnnotateTokenBook } from "../../src/server/annotate";
import { createCapabilityBook } from "../../src/server/capability";
import type { HandlerContext } from "../../src/server/handlers";
import { assetReply, indexReply, themeReply, themesReply } from "../../src/server/static";
import { nodeStyleDeps } from "../../src/style";

const themesOf = (value: unknown): readonly string[] => {
  if (value === null || typeof value !== "object") return [];
  const raw: unknown = Reflect.get(value, "themes");
  return Array.isArray(raw) ? raw.filter((name): name is string => typeof name === "string") : [];
};

interface Fixture {
  readonly workspace: string;
  readonly home: string;
  readonly appDir: string;
  readonly stylesRoot: string;
}

let fx: Fixture = { workspace: "", home: "", appDir: "", stylesRoot: "" };

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), "hr-static-"));
  const workspace = join(root, "ws");
  const home = join(root, "home");
  const appDir = join(root, "app");
  const stylesRoot = join(root, "styles");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(join(appDir, "assets"), { recursive: true });
  mkdirSync(join(stylesRoot, "atelier-editorial"), { recursive: true });
  mkdirSync(join(home, ".hreader", "styles"), { recursive: true });
  writeFileSync(join(appDir, "index.html"), "<!doctype html><p>app</p>", "utf8");
  writeFileSync(join(appDir, "assets", "app.js"), "console.log(1)", "utf8");
  writeFileSync(join(stylesRoot, "atelier-editorial", "theme.css"), ":root{--ink:#111}", "utf8");
  fx = { workspace, home, appDir, stylesRoot };
});

afterAll(() => {
  rmSync(join(fx.workspace, ".."), { recursive: true, force: true });
});

const ctxOf = (appDir: string): HandlerContext => ({
  workspace: fx.workspace,
  appDir,
  home: fx.home,
  deps: nodeStyleDeps(fx.workspace),
  styleDeps: { ...nodeStyleDeps(fx.workspace), home: fx.home, stylesRoot: fx.stylesRoot },
  caps: createCapabilityBook(),
  annotateTokens: createAnnotateTokenBook(nodeStyleDeps(fx.workspace).clock),
});

describe("indexReply · 构建产物与未构建回退", () => {
  it("should 302 to /?doc= when the app is built and no doc query is given", async () => {
    const reply = await indexReply(ctxOf(fx.appDir), "doc.html", false);
    expect(reply.status).toBe(302);
    expect(reply.headers["location"]).toBe("/?doc=doc.html");
  });

  it("should serve index.html when the doc query is present", async () => {
    const reply = await indexReply(ctxOf(fx.appDir), "doc.html", true);
    expect(reply.status).toBe(200);
    expect(reply.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(String(reply.body)).toContain("app");
  });

  it("should fall back to the minimal home page when appDir is empty (still 200)", async () => {
    const reply = await indexReply(ctxOf(""), "doc.html", false);
    expect(reply.status).toBe(200);
    expect(String(reply.body)).toContain('href="/s/doc.html"');
    expect(reply.headers["content-security-policy"]).toBeDefined();
  });

  it("should 404 when appDir is set but index.html is missing", async () => {
    const reply = await indexReply(ctxOf(join(fx.workspace, "nope")), "doc.html", true);
    expect(reply.status).toBe(404);
    expect(String(reply.body)).toContain("index.html");
  });

  it("should keep 200 with an empty body when the doc is no longer a document", async () => {
    // 文档在启动后被换成“不是文档”的东西：首页是 `hr serve` 的自检入口，不该因此变 5xx。
    writeFileSync(join(fx.workspace, "plain.html"), "<p>随手记一段</p>", "utf8");
    const reply = await indexReply(ctxOf(""), "plain.html", false);

    expect(reply.status).toBe(200);
    expect(String(reply.body)).toContain('href="/s/plain.html"');
    expect(String(reply.body)).not.toContain("随手记一段");
  });
});

describe("assetReply · 白名单与越界", () => {
  it.each([["../secret.js"], ["/abs.js"], ["a\\b.js"], [""], ["a".repeat(9000)]])(
    "should 404 for the illegal asset path %s",
    async (raw) => {
      const reply = await assetReply(ctxOf(fx.appDir), raw);
      expect(reply.status).toBe(404);
      expect(String(reply.body)).toContain("资源路径不合法");
    },
  );

  it("should serve a real asset with a content type", async () => {
    const reply = await assetReply(ctxOf(fx.appDir), "app.js");
    expect(reply.status).toBe(200);
    expect(String(reply.headers["content-type"])).toContain("javascript");
    expect(String(reply.body)).toContain("console.log");
  });

  it("should treat ENAMETOOLONG from the fs as a 404 rather than a 500 (ruling #9)", async () => {
    const base = ctxOf(fx.appDir);
    const failing = {
      ...base.deps.fs,
      readFile: () => Promise.reject(Object.assign(new Error("x"), { code: "ENAMETOOLONG" })),
    };
    const reply = await assetReply({ ...base, deps: { ...base.deps, fs: failing } }, "app.js");
    expect(reply.status).toBe(404);
    expect(String(reply.body)).toContain("资源不存在");
  });

  it("should 404 for a missing asset", async () => {
    const reply = await assetReply(ctxOf(fx.appDir), "missing.js");
    expect(reply.status).toBe(404);
    expect(String(reply.body)).toContain("资源不存在");
  });
});

describe("themesReply · 内建清单", () => {
  it("should list the builtin theme", async () => {
    const reply = await themesReply(ctxOf(fx.appDir));
    expect(reply.status).toBe(200);
    expect(JSON.parse(String(reply.body))).toEqual({
      themes: ["atelier-editorial"],
      default: "atelier-editorial",
    });
  });
});

describe("themesReply · 用户主题", () => {
  it("should list a user theme alongside builtin themes", async () => {
    const home = mkdtempSync(join(tmpdir(), "hr-useronly-"));
    mkdirSync(join(home, ".hreader", "styles", "mine"), { recursive: true });
    writeFileSync(
      join(home, ".hreader", "styles", "mine", "theme.css"),
      ":root{--ink:#444}",
      "utf8",
    );
    const base = ctxOf(fx.appDir);
    const reply = await themesReply({ ...base, styleDeps: { ...base.styleDeps, home } });
    rmSync(home, { recursive: true, force: true });

    expect(reply.status).toBe(200);
    expect(themesOf(JSON.parse(String(reply.body)))).toContain("mine");
  });
});

describe("themesReply · 同名主题只出现一次", () => {
  it("should dedupe a user theme that shadows a builtin id", async () => {
    const home = mkdtempSync(join(tmpdir(), "hr-shadow-"));
    mkdirSync(join(home, ".hreader", "styles", "atelier-editorial"), { recursive: true });
    writeFileSync(
      join(home, ".hreader", "styles", "atelier-editorial", "theme.css"),
      ":root{--ink:#333}",
      "utf8",
    );
    const base = ctxOf(fx.appDir);
    const reply = await themesReply({
      ...base,
      styleDeps: { ...base.styleDeps, home },
    });
    const themes = themesOf(JSON.parse(String(reply.body)));
    expect(themes.filter((name) => name === "atelier-editorial")).toHaveLength(1);
    expect(themes).toEqual(["atelier-editorial"]);
    rmSync(home, { recursive: true, force: true });
  });
});

describe("themesReply · 清单为空时的默认名", () => {
  it("should fall back to the default name when no theme directory is usable", async () => {
    const empty = mkdtempSync(join(tmpdir(), "hr-nostyles-"));
    const ctx = {
      ...ctxOf(fx.appDir),
      styleDeps: { ...nodeStyleDeps(empty), home: join(empty, "h"), stylesRoot: join(empty, "s") },
    };
    const reply = await themesReply(ctx);
    expect(JSON.parse(String(reply.body))).toEqual({
      themes: ["atelier-editorial"],
      default: "atelier-editorial",
    });
    rmSync(empty, { recursive: true, force: true });
  });
});

describe("themeReply · CSS 与未知 id", () => {
  it("should return the CSS of a builtin theme", async () => {
    const reply = await themeReply(ctxOf(fx.appDir), "atelier-editorial");
    expect(reply.status).toBe(200);
    expect(String(reply.headers["content-type"])).toBe("text/css; charset=utf-8");
    expect(String(reply.body)).toContain("--ink:#111");
  });

  it("should surface unknown_style as a 404 outcome (not a 500)", async () => {
    await expect(themeReply(ctxOf(fx.appDir), "nope-%%%")).rejects.toBeInstanceOf(HrError);
  });
});
