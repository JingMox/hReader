// 这层管：`ui://hreader/view/{docId}` 的文档注入面。
// 之前 `viewHtmlOf` 把盘上字节原样塞 `<article>${text}</article>`：工作区里任何一份外来 HTML
// （`<script>`、`on*`、外链资源、`</article>` 逃逸、会改写整个视图页的 `<style>`）都进了
// 宿主渲染的 mcp-app 页面。契约：视图是**静态内容预览**——可执行面、外链面、注释、
// 文档级样式一律剥掉，正文必须还在。

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { docIdOf } from "../src/ui";
import { sessionOf } from "./harness";

const VIEW_URI_PREFIX = "ui://hreader/view/";

const textOfResource = (contents: readonly unknown[]): string => {
  const [first] = contents;
  return typeof first === "object" &&
    first !== null &&
    "text" in first &&
    typeof first.text === "string"
    ? first.text
    : "";
};

const viewTextOf = async (relativePath: string): Promise<string> => {
  const session = await sessionOf();
  const result = await session.client.readResource({
    uri: `${VIEW_URI_PREFIX}${docIdOf(relativePath)}`,
  });
  await session.close();
  return textOfResource(result.contents);
};

let workspace = "";

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "hreader-mcp-ui-xss-"));
  process.chdir(workspace);
  // 视图拿端口要读 ~/.hreader/daemon.json：把 HOME 指进临时目录，测试不撞开发机真配置。
  await mkdir(join(workspace, "home"), { recursive: true });
  process.env["HOME"] = join(workspace, "home");
});

afterEach(async () => {
  process.chdir(tmpdir());
  await rm(workspace, { recursive: true, force: true });
});

describe("ui://hreader/view · 文档净化", () => {
  it("should strip scripts, handlers, external resources and doc-level styles but keep content", async () => {
    await writeFile(
      join(workspace, "evil.html"),
      [
        "<!doctype html><html><head><title>t</title>",
        '<style>@import "https://evil.example/x.css";body{display:none}</style>',
        "</head><body>",
        "<article>",
        "</article><script>window.prompt_inject()</script>",
        '<p onclick="exfil()">正文还在</p>',
        '<img src="https://evil.example/track.png">',
        '<a href="javascript:alert(1)">点我</a>',
        "<!-- 注释 -->",
        "</body></html>",
      ].join(""),
      "utf8",
    );

    const view = await viewTextOf("evil.html");

    expect(view).toContain("正文还在");
    expect(view).toContain("点我");
    expect(view).not.toContain("<script");
    expect(view).not.toContain("prompt_inject");
    expect(view).not.toContain("onclick");
    expect(view).not.toContain("evil.example");
    expect(view).not.toContain("javascript:");
    // 文档级 <style> 会改写整个视图页（display:none / @import 外联）：整删，视图用自己的样式。
    expect(view).not.toContain("display:none");
    expect(view).not.toContain("@import");
    expect(view).not.toContain("<!--");
  });

  it("should keep a plain managed document readable end to end", async () => {
    await writeFile(
      join(workspace, "doc.html"),
      '<article data-hr-id="hr-0"><h1 data-hr-id="hr-1">标题</h1><p data-hr-id="hr-2">正文</p></article>',
      "utf8",
    );

    const view = await viewTextOf("doc.html");

    expect(view).toContain("标题");
    expect(view).toContain("正文");
  });
});
