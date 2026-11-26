// This layer covers references' "copy and run" promise plus the doc/code cross-check of component ids.
//
// Why read source text instead of importing: `COMPONENT_WHITELIST` is not on `@hreader/core`'s public surface,
// and the cross-check wants "the ids written in the doc are byte-identical to the code literals" — reading text stays closer to the promise than routing around the export surface.

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

describe("components-spec.md · every fragment passes hr patch verbatim", () => {
  const blocks = htmlBlocks(readFileSync(SPEC, "utf8"));

  it("should extract at least the eight component snippets", () => {
    expect(blocks.length).toBeGreaterThanOrEqual(8);
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
    // The fragment's root element gets a data-hr-id from core, so literal text cannot be compared:
    // assert "the component id entered the doc" + "the doc still round-trips parse/serialize stable".
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

describe("component ids · doc and code agree both ways", () => {
  it("should declare exactly eight ids on both sides", () => {
    expect(docIds.size).toBe(8);
    expect(sourceIds.size).toBe(8);
  });
});

describe("component ids · neither more nor fewer allowed", () => {
  it("should be a superset-free bijection", () => {
    expect([...docIds].sort()).toEqual([...sourceIds].sort());
  });
});
