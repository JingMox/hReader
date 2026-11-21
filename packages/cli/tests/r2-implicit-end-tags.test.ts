// R2-06a（docs/05:59「块级子节点不许落在 phrasing-only 容器里」）：`normalize` 遇到 HTML5 隐含结束
// 的写法（`<p>` 里塞 `<table>`/`<div>`/`<ul>`）必须把块**拆出来当兄弟**，而不是留成 `<p>` 的子节点。
// 这层管：拆开后表格/块不在 `<p>` 里、`<p>` 仍以自己的 id 读到自己的文本、二次 normalize 是 `unchanged`。

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { checked, seed } from "./cli-support";
import { runCli, withTempDir } from "./harness";

/** 只有一个 `<article>`、里面一个裸 `<p>` + 一段内联的块：正是 R2-06a 的输入形态。 */
const nestingDoc = (inner: string): string =>
  [
    "<!doctype html>",
    "<html><head><title>t</title></head><body>",
    `<article><p>前${inner}</p></article>`,
    "</body></html>",
  ].join("\n");

const CASES: readonly {
  readonly name: string;
  readonly inner: string;
  readonly blockTag: string;
}[] = [
  { name: "<table>", inner: "<table><tr><td>1</td></tr></table>", blockTag: "table" },
  { name: "<div>", inner: "<div>b</div>", blockTag: "div" },
  { name: "<ul>", inner: "<ul><li>b</li></ul>", blockTag: "ul" },
];

/** `<p>` 里不许有 `table`/`div`/`ul`：拆对的判据就是 p 之后紧跟着同名块，且它不在 p 内。 */
const expectSplitOutOfParagraph = (html: string, blockTag: string): string => {
  const paragraph = /<p data-hr-id="([^"]+)">前<\/p>/u.exec(html);
  if (paragraph === null) throw new Error(`规范化之后没有“只含『前』的 <p>”：${html}`);
  const paragraphId = String(paragraph[1]);
  // `<p …>前</p>` 之后紧接同名块 = 它是 p 的**兄弟**（在 p 里的话根本不会出现这个片段）。
  expect(html).toContain(`</p><${blockTag} data-hr-id=`);
  expect(html).not.toMatch(new RegExp(`<p[^>]*>[^<]*<${blockTag}`, "u"));
  return paragraphId;
};

describe("normalize · 隐含结束标签（R2-06a）", () => {
  it.each(CASES)(
    "should split $name out of the paragraph and keep the paragraph addressable",
    async ({ inner, blockTag }) => {
      await withTempDir(async (dir) => {
        seed(dir, "a.html", nestingDoc(inner));

        const written = checked(await runCli(["normalize", "a.html", "--write"], { cwd: dir }));
        expect(written.code).toBe(0);
        const paragraphId = expectSplitOutOfParagraph(
          readFileSync(`${dir}/a.html`, "utf8"),
          blockTag,
        );

        // `<p>` 的 id 仍指它自己那段文本：拆开块不许把锚点带跑。
        const read = checked(await runCli(["read", "a.html", paragraphId], { cwd: dir }));
        expect(read.stdout).toContain("前");
        expect(read.stdout).not.toContain(blockTag);
        expect(read.stdout).toContain(`data-hr-id="${paragraphId}"`);

        // 二次 normalize 必须一字不动：拆一次就稳定，不能每跑一次都改字节。
        const again = checked(await runCli(["normalize", "a.html", "--write"], { cwd: dir }));
        expect(again.stdout).toMatch(/^unchanged a\.html \(\d+ bytes，已带齐 data-hr-id\)\n$/u);
      });
    },
  );
});
