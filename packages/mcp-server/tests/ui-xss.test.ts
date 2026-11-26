// This layer: the document-injection surface of `ui://hreader/view/{docId}`.
// `viewHtmlOf` used to stuff on-disk bytes verbatim into `<article>${text}</article>`: any foreign HTML in the workspace
// (`<script>`, `on*` handlers, external resources, `</article>` escapes, view-page-rewriting `<style>`) flowed into
// the host-rendered mcp-app page. Contract: the view is a **static content preview** — executable surface, external-resource surface, comments,
// and document-level styles are all stripped; the body must survive.

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
  // The view reads ~/.hreader/daemon.json for the port: point HOME at a temp dir so tests do not hit the dev machine's real config.
  await mkdir(join(workspace, "home"), { recursive: true });
  process.env["HOME"] = join(workspace, "home");
});

afterEach(async () => {
  process.chdir(tmpdir());
  await rm(workspace, { recursive: true, force: true });
});

describe("ui://hreader/view · document sanitization", () => {
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
    // Document-level <style> would rewrite the whole view page (display:none / @import external links): delete it; the view uses its own styles.
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
