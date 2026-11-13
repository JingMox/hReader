// 这层管：references 的"复制即用"承诺（AC5a 前置）与组件 id 的文档/代码交叉校验。
//
// 为什么读源码文本而不是 import：`COMPONENT_WHITELIST` 不在 `@hreader/core` 的公开面上，
// 交叉校验要的是"文档里写的 id 与代码里的字面量逐字一致"，读文本比绕过导出面更贴近承诺。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseHtml, serializeHtml } from "@hreader/core";

import { runCli, withTempDir } from "./harness";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const repo = (path: string): string => fileURLToPath(new URL(`../../../${path}`, import.meta.url));

const SPEC = repo("skills/hreader/references/components-spec.md");
const CONSTANTS = repo("packages/core/src/html/constants.ts");

const htmlBlocks = (markdown: string): readonly string[] =>
  [...markdown.matchAll(/```html\n([\s\S]*?)```/gu)].map((match) => match[1] ?? "");

const DOC = [
  '<article data-hr-id="hr-a"><h2 data-hr-id="hr-b">标题</h2>',
  '<p data-hr-id="hr-c">正文</p></article>',
].join("");

const stable = (html: string): string => serializeHtml(parseHtml(html));

describe("components-spec.md · 每个片段都能原样通过 hr patch", () => {
  const blocks = htmlBlocks(readFileSync(SPEC, "utf8"));

  it("should extract at least the seven component snippets", () => {
    expect(blocks.length).toBeGreaterThanOrEqual(7);
  });

  it.each(htmlBlocks(readFileSync(SPEC, "utf8")).map((block, index) => [index, block] as const))(
    "should patch snippet #%d and keep the document parse-stable",
    async (index, block) => {
      await patchSnippet(index, block);
    },
  );
});

const patchSnippet = async (index: number, block: string): Promise<void> =>
  withTempDir(async (raw) => {
    const doc = join(raw, "doc.html");
    const frag = join(raw, `frag-${String(index)}.html`);
    writeFileSync(doc, DOC);
    writeFileSync(frag, block);

    const result = await runCli(
      [
        "patch",
        "doc.html",
        "hr-c",
        "--action",
        "insert_after",
        "--html-file",
        `frag-${String(index)}.html`,
        "--json",
      ],
      { cwd: raw },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("\u001B");

    const after = readFileSync(doc, "utf8");
    // 片段根元素会被 core 补上 data-hr-id，所以不能比字面文本：
    // 断"组件 id 进了文档" + "文档仍能 parse/serialize 往返稳定"。
    const component = /data-hr-component="([a-z-]+)"/u.exec(block)?.[1] ?? "";
    expect(after).toContain(`data-hr-component="${component}"`);
    expect(after).toContain("hr-c");
    expect(stable(stable(after))).toBe(stable(after));
  });

const docIds: ReadonlySet<string> = new Set(
  [...readFileSync(SPEC, "utf8").matchAll(/data-hr-component="([a-z-]+)"/gu)].map(
    (match) => match[1] ?? "",
  ),
);

const sourceIds: ReadonlySet<string> = new Set(
  [
    ...(
      /COMPONENT_WHITELIST[^=]*=\s*\[([\s\S]*?)\]/u.exec(readFileSync(CONSTANTS, "utf8"))?.[1] ?? ""
    ).matchAll(/"([a-z-]+)"/gu),
  ].map((match) => match[1] ?? ""),
);

describe("组件 id · 文档与代码双向一致", () => {
  it("should declare exactly seven ids on both sides", () => {
    expect(docIds.size).toBe(7);
    expect(sourceIds.size).toBe(7);
  });
});

describe("组件 id · 不允许多或少", () => {
  it("should be a superset-free bijection", () => {
    expect([...docIds].sort()).toEqual([...sourceIds].sort());
  });
});
