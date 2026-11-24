// 这层管：端到端链路（一份真实文档跑完 outline/read/patch/style/lint/visual）；不 mock。

import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseHtml, serializeHtml } from "@hreader/core";

import { expectNoAnsi, fieldOf, parseJsonLine, runCli, textOf, withTempDir } from "./harness";

const repo = (path: string): string => fileURLToPath(new URL(`../../../${path}`, import.meta.url));

const SPEC = repo("skills/hreader/references/components-spec.md");
const THEME = repo("styles/atelier-editorial/theme.css");

const snippet = (component: string): string => {
  const markdown = readFileSync(SPEC, "utf8");
  const heading = markdown.indexOf(`\`${component}\``);
  const fence = markdown.indexOf("```html\n", heading);
  const end = markdown.indexOf("```", fence + 8);
  if (heading < 0 || fence < 0 || end < 0) throw new Error(`references 里没有 ${component} 片段`);
  return markdown.slice(fence + 8, end);
};

const sha = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

const stable = (html: string): string => serializeHtml(parseHtml(html));

const outlineStep = async (dir: string): Promise<void> => {
  const outline = await runCli(["outline", "post.html", "--json"], { cwd: dir });
  expectNoAnsi(outline);
  expect(outline.code).toBe(0);
  expect(parseJsonLine(outline.stdout)).toMatchObject({
    data: { nodes: [{ id: "hr-b", level: 2, text: "早读" }] },
  });
};

const styleSteps = async (dir: string): Promise<void> => {
  const themed = await runCli(["style", "post.html", "--visual", "atelier-editorial", "--json"], {
    cwd: dir,
  });
  expectNoAnsi(themed);
  expect(themed.code).toBe(0);
  expect(parseJsonLine(themed.stdout)).toMatchObject({ data: { changed: true } });
  expect(readFileSync(join(dir, "post.html"), "utf8")).toContain('<style id="hr-theme">');

  const again = await runCli(["style", "post.html", "--visual", "atelier-editorial", "--json"], {
    cwd: dir,
  });
  expect(again.code).toBe(0);
  expect(parseJsonLine(again.stdout)).toMatchObject({ data: { changed: false } });
};

const readAndLintSteps = async (dir: string): Promise<void> => {
  const read = await runCli(
    ["read", "post.html", '[data-hr-id="hr-c"]', "--max-bytes", "80", "--json"],
    {
      cwd: dir,
    },
  );
  expect(read.code).toBe(0);
  expect(parseJsonLine(read.stdout)).toMatchObject({ data: { ids: ["hr-c"] } });
  expect(textOf(fieldOf(fieldOf(parseJsonLine(read.stdout), "data"), "html"))).toContain(
    'data-hr-id="hr-c"',
  );

  const lint = await runCli(["style", "post.html", "--lint", "--json"], { cwd: dir });
  expect(lint.code).toBe(0);
  expect(parseJsonLine(lint.stdout)).toMatchObject({ data: { hits: [] } });
};

const patchStep = async (dir: string): Promise<void> => {
  writeFileSync(join(dir, "fade.html"), snippet("split-compare"));
  const patched = await runCli(
    [
      "patch",
      "post.html",
      "hr-c",
      "--action",
      "insert_after",
      "--html-file",
      "fade.html",
      "--json",
    ],
    { cwd: dir },
  );
  expectNoAnsi(patched);
  expect(patched.code).toBe(0);
  expect(parseJsonLine(patched.stdout)).toMatchObject({ data: { changed: true } });
};

const initialDoc = (): string =>
  [
    "<!doctype html>",
    '<html lang="zh-CN"><head><meta charset="utf-8"><title>文章</title></head><body>',
    '<article data-hr-id="hr-a"><h2 data-hr-id="hr-b">早读</h2>',
    `<p data-hr-id="hr-c">导语</p>`,
    "</article></body></html>",
  ].join("\n");

describe("端到端 · 断链即红", () => {
  it("should run the whole chain on one real document", async () => {
    await withTempDir(async (raw) => {
      const dir = realpathSync(raw);
      const doc = join(dir, "post.html");
      writeFileSync(doc, initialDoc());
      const before = sha(readFileSync(doc));

      await outlineStep(dir);
      await styleSteps(dir);
      await readAndLintSteps(dir);
      await patchStep(dir);

      // 整条链的终态：字节变了、可解析、幂等序列化
      const after = readFileSync(doc, "utf8");
      expect(sha(readFileSync(doc))).not.toBe(before);
      expect(stable(stable(after))).toBe(stable(after));
      expect(after).toContain("data-hr-component");
    }, 30_000);
  });

  it("should have a theme selector for every component the references advertise", () => {
    const css = readFileSync(THEME, "utf8");
    const spec = readFileSync(SPEC, "utf8");
    const advertised = new Set(componentIds(spec, /data-hr-component="([a-z-]+)"/gu));
    const styled = new Set(componentIds(css, /\[data-hr-component="([a-z-]+)"\]/gu));

    expect([...advertised].filter((id) => !styled.has(id))).toEqual([]);
  });
});

const componentIds = (text: string, pattern: RegExp): readonly string[] =>
  [...text.matchAll(pattern)].map((match) => match[1] ?? "");
