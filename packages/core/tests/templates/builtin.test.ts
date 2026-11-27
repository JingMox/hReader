// 这层管：内置模板与仓库事实的一致性——内嵌 theme.css 与 styles/<visual>/theme.css 逐字节相等
// （scripts/embed-theme-css.mjs 的再生成产出），以及"kind 对应内置模板新建 == hr new --kind 产物"
// 这条 F2a 的兼容承诺。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { classifyDocument, checkLayout, parseHtml } from "../../src";
import type { HtmlNode } from "../../src/html/constants";
import { newDocumentHtml } from "../../src/layout/kinds";
import { BUILTIN_TEMPLATES } from "../../src/templates/builtin";
import { THEME_CSS } from "../../src/templates/builtin/theme-css";
import { createFromTemplate, readTemplate } from "../../src/templates";
import { fakeFs, rootsOf, depsAt } from "./harness";

const themeFile = (visual: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../../../styles/${visual}/theme.css`, import.meta.url)),
    "utf8",
  );

/**
 * 结构指纹：标签序列 + 文本 + 非注入属性。采掉 `data-hr-id`（create 时注入）、`<style>` 块
 * （主题内联产物，参照侧根本没有）与纯空白文本节点（序列化可能改写缩进）——
 * 剩下来的就是骨架本身，两边指纹相等 = 结构等价。
 */
const STRUCTURAL_TEXT = (node: HtmlNode): boolean =>
  !(node.kind === "text" && node.value.trim().length === 0) &&
  !(node.kind === "element" && node.tag === "style");

const fingerprint = (node: HtmlNode): unknown => {
  if (node.kind === "text") return { kind: "text", value: node.value.trim() };
  if (node.kind === "doctype") return { kind: "doctype", name: node.name };
  if (node.kind !== "element" && node.kind !== "document") return node.kind;
  if (node.kind === "document") {
    return { tag: "document", children: node.children.filter(STRUCTURAL_TEXT).map(fingerprint) };
  }
  return {
    tag: node.tag,
    attrs: node.attrs.filter(([name]) => name !== "data-hr-id"),
    children: node.children.filter(STRUCTURAL_TEXT).map(fingerprint),
  };
};

const KINDS = ["note", "report", "minutes", "brief", "slides"] as const;

describe("内置模板 · theme.css 与仓库源文件逐字节一致", () => {
  it("should keep embedded atelier-editorial and deck-noir css in lockstep with styles/", () => {
    expect(THEME_CSS["atelier-editorial"]).toBe(themeFile("atelier-editorial"));
    expect(THEME_CSS["deck-noir"]).toBe(themeFile("deck-noir"));
  });
});

describe("内置模板 · 与 newDocumentHtml 的等价（F2a 兼容承诺）", () => {
  it("should ship each kind template whose entry is exactly newDocumentHtml output", () => {
    for (const kind of KINDS) {
      const builtin = BUILTIN_TEMPLATES.find((template) => template.manifest.id === kind);
      if (builtin === undefined) throw new Error(`内置清单里缺 ${kind}`);
      expect(builtin.entry).toBe(newDocumentHtml({ kind, title: "Untitled" }));
      expect(builtin.manifest.format).toBe("managed");
    }
  });

  it.each([...KINDS])(
    "should create a document structurally identical to `hr new --kind %s`",
    async (kind) => {
      const fake = fakeFs({ "/ws/keep.html": "x" });
      const result = await createFromTemplate(
        { id: kind, target: `${kind}.html`, title: "等价标题" },
        rootsOf(),
        depsAt(fake),
      );
      expect(result.path).toBe(`${kind}.html`);

      const created = new TextDecoder().decode(
        fake.state.files.get(`/ws/${kind}.html`) ?? new Uint8Array(),
      );
      const parsed = parseHtml(created);
      expect(classifyDocument(parsed).cls).toBe("managed");
      expect(checkLayout(parsed.root)).toHaveLength(0);

      // 等价基准：`hr new --kind` 的产物就是 newDocumentHtml；注入 id/主题之外的指纹必须一致。
      const reference = parseHtml(newDocumentHtml({ kind, title: "等价标题" }));
      expect(fingerprint(parsed.root)).toEqual(fingerprint(reference.root));
    },
  );
});

describe("内置模板 · blank-html", () => {
  it("should create a free-form html doc verbatim plus title/theme rewrite", async () => {
    const fake = fakeFs({ "/ws/keep.html": "x" });
    const template = await readTemplate("blank-html", rootsOf(), depsAt(fake));
    const builtin = BUILTIN_TEMPLATES.find((one) => one.manifest.id === "blank-html");
    if (builtin === undefined) throw new Error("内置清单里缺 blank-html");

    const result = await createFromTemplate(
      { id: "blank-html", target: "free.html", title: "Free" },
      rootsOf(),
      depsAt(fake),
    );
    const written = new TextDecoder().decode(
      fake.state.files.get("/ws/free.html") ?? new Uint8Array(),
    );

    // html 模板且无资源：除 title/h1 与主题块外逐字节保留骨架。
    const expected = template.entry
      .replace("<title>Untitled</title>", "<title>Free</title>")
      .replace("<h1>Untitled</h1>", "<h1>Free</h1>")
      .replace("</head>", `<style id="hr-theme">${builtin.style}</style></head>`);
    expect(written).toBe(expected);
    expect(result.assets).toHaveLength(0);
  });
});
