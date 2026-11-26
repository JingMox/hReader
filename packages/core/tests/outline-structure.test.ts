// 这层管：`hr_outline` 的包含范围、层级推导与排序。

import { describe, expect, it } from "vitest";

import { buildOutline, parseHtml } from "../src/index";
import type { Outline, OutlineNode } from "../src/index";

const DOCS_SAMPLE = [
  '<article data-hr-id="art">',
  '<header data-hr-id="sec-header"><h1 data-hr-id="title-main">分布式一致性协议深度解析</h1>',
  "<p>一致性是分布式系统的核心难题。</p></header>",
  '<section data-hr-id="sec-problem"><h2 data-hr-id="h2-problem">为什么主从复制会丢数据？</h2>',
  "<p>异步复制在主库崩溃时会丢尾部日志。</p></section>",
  "</article>",
].join("");

const articleOf = (body: string): string => `<article data-hr-id="art">${body}</article>`;

const outlineOf = (html: string): Outline => buildOutline(parseHtml(html));

/** 只保留结构可见的部分，断言才有可读性。 */
const shapeOf = (nodes: readonly OutlineNode[]): readonly unknown[] =>
  nodes.map((node) => [node.id, node.tag, node.level, node.text, shapeOf(node.children)]);

const codesOf = (outline: Outline): readonly string[] =>
  outline.diagnostics.map((diagnostic) => diagnostic.code);

const section = (id: string, body: string): string =>
  `<section data-hr-id="${id}">${body}</section>`;
const heading = (level: number, id: string, text: string): string =>
  `<h${String(level)} data-hr-id="${id}">${text}</h${String(level)}>`;

const idsOf = (nodes: readonly OutlineNode[]): readonly string[] =>
  nodes.flatMap((node) => [node.id, ...idsOf(node.children)]);

const depthOf = (nodes: readonly OutlineNode[]): number =>
  nodes.reduce((deepest, node) => Math.max(deepest, 1 + depthOf(node.children)), 0);

describe("hr_outline · 结构", () => {
  it("should outline the spec sample as header + two sections with their headings", () => {
    expect(shapeOf(outlineOf(DOCS_SAMPLE).nodes)).toEqual([
      [
        "sec-header",
        "header",
        1,
        "分布式一致性协议深度解析",
        [["title-main", "h1", 1, "分布式一致性协议深度解析", []]],
      ],
      [
        "sec-problem",
        "section",
        2,
        "为什么主从复制会丢数据？",
        [["h2-problem", "h2", 2, "为什么主从复制会丢数据？", []]],
      ],
    ]);
  });
});
describe("hr_outline · 结构 · 续 1", () => {
  it("should give an untitled nested section the level and text of its first heading", () => {
    const outline = outlineOf(
      articleOf(section("s1", section("s2", section("s3", heading(2, "h", "标题"))))),
    );

    expect(shapeOf(outline.nodes)).toEqual([
      [
        "s1",
        "section",
        2,
        "标题",
        [
          [
            "s2",
            "section",
            2,
            "标题",
            [["s3", "section", 2, "标题", [["h", "h2", 2, "标题", []]]]],
          ],
        ],
      ],
    ]);
  });
});
describe("hr_outline · 结构 · 续 1", () => {
  it("should derive a section level from a h3 that has no h2 above it", () => {
    const outline = outlineOf(articleOf(section("s", heading(3, "h", "三级"))));

    expect(shapeOf(outline.nodes)).toEqual([
      ["s", "section", 3, "三级", [["h", "h3", 3, "三级", []]]],
    ]);
  });
});
describe("hr_outline · 结构 · 续 1", () => {
  it("should take a section level from a heading nested in a header (impl hint #2)", () => {
    const outline = outlineOf(
      articleOf(section("s", '<header data-hr-id="hdr">' + heading(4, "h", "丁") + "</header>")),
    );

    expect(shapeOf(outline.nodes)).toEqual([
      ["s", "section", 4, "丁", [["hdr", "header", 4, "丁", [["h", "h4", 4, "丁", []]]]]],
    ]);
  });

  it("should build the tree from a flat h1–h4 run by level, in document order", () => {
    const outline = outlineOf(
      articleOf(
        heading(1, "a", "A") + heading(3, "c", "C") + heading(2, "b", "B") + heading(4, "d", "D"),
      ),
    );

    expect(shapeOf(outline.nodes)).toEqual([
      [
        "a",
        "h1",
        1,
        "A",
        [
          ["c", "h3", 3, "C", []],
          ["b", "h2", 2, "B", [["d", "h4", 4, "D", []]]],
        ],
      ],
    ]);
  });
});
describe("hr_outline · 结构 · 续 1 · 续 1", () => {
  it("should record a top-level untitled section as level 0 without a diagnostic", () => {
    const outline = outlineOf(articleOf(section("s", "<p>没有标题</p>")));

    expect(shapeOf(outline.nodes)).toEqual([["s", "section", 0, "", []]]);
    expect(codesOf(outline)).toEqual([]);
    expect(outline.wordCount).toBe(4);
  });
});
describe("hr_outline · 结构 · 续 1 · 续 1", () => {
  it("should return empty nodes and no diagnostic for a document without headings", () => {
    const outline = outlineOf(articleOf("<p>只有段落，没有标题。</p>"));

    expect(outline.nodes).toEqual([]);
    expect(codesOf(outline)).toEqual([]);
    expect(outline.wordCount).toBe(8);
  });
});
describe("hr_outline · 结构 · 续 2", () => {
  it("should return empty nodes for an empty article and for a document without article", () => {
    expect(outlineOf(articleOf("")).nodes).toEqual([]);
    expect(outlineOf("<p>no article at all</p>").nodes).toEqual([]);
    expect(outlineOf("<p>no article at all</p>").wordCount).toBe(0);
  });

  it("should ignore headings that live outside the article", () => {
    const outline = outlineOf(
      `<main>${heading(1, "outside", "页头")}</main>${articleOf(heading(1, "inside", "正文"))}`,
    );

    expect(shapeOf(outline.nodes)).toEqual([["inside", "h1", 1, "正文", []]]);
  });

  it("should not outline h5/h6 (level above the 4 limit) but still count their text", () => {
    const outline = outlineOf(articleOf(section("s", heading(5, "h5", "五级"))));

    expect(shapeOf(outline.nodes)).toEqual([["s", "section", 0, "", []]]);
    expect(outline.wordCount).toBe(2);
  });

  // 无 id 的标题自己不入树，但它的层级仍决定外层 section 的 level/text（section 取“其首个标题”，
  // 未要求标题必须有 id）。这是个容易反向实现的口径，单独立一条。
});
describe("hr_outline · 结构 · 续 2 · 续 1", () => {
  it("should omit nodes without a legal data-hr-id and diagnose each of them", () => {
    const outline = outlineOf(
      articleOf(
        '<section data-hr-id="ok">' +
          "<h2>无 id</h2>" +
          '<h2 data-hr-id="Bad Id">非法</h2>' +
          '<h2 data-hr-id="">空串</h2>' +
          "</section>",
      ),
    );

    expect(shapeOf(outline.nodes)).toEqual([["ok", "section", 2, "无 id", []]]);
    // 诊断层按 code+message 去重，并把条数写进文案（`同报文 N 条`）——所以三条同文案的缺 id 标题
    // 只留一条诊断，但**条数没丢**。这也是为什么 `Diagnostic` 没有 path 仍能定位"有三处"。
    expect(codesOf(outline)).toEqual(["outline_node_without_id"]);
    expect(outline.diagnostics[0]?.message).toBe(
      "<h2> 缺少合法 data-hr-id，已从 outline 省略（同报文 3 条）",
    );
  });
});
describe("hr_outline · 结构 · 续 3", () => {
  it("should stop expanding below depth 4 and diagnose the structural truncation", () => {
    const nested = ["a", "b", "c", "d", "e", "f"].reduceRight(
      (inner, id) => section(id, inner),
      heading(2, "h", "深"),
    );
    const outline = outlineOf(articleOf(nested));

    expect(depthOf(outline.nodes)).toBe(4);
    expect(codesOf(outline)).toContain("outline_truncated");
    expect(
      outline.diagnostics.find((diagnostic) => diagnostic.code === "outline_truncated")?.message,
    ).toContain("结构/文本上限");
  });

  it("should truncate a node text at 120 code points and diagnose it once", () => {
    const outline = outlineOf(articleOf(heading(1, "h", "字".repeat(150))));
    const [first] = outline.nodes;

    expect(first?.text.length).toBe(121);
    expect(first?.text.endsWith("…")).toBe(true);
    expect(first?.text.startsWith("字".repeat(120))).toBe(true);
    expect(codesOf(outline).filter((code) => code === "outline_truncated")).toEqual([
      "outline_truncated",
    ]);
  });
});
describe("hr_outline · 结构 · 续 3 · 续 1", () => {
  it("should keep node wordCount as the subtree total and roll it up to the article", () => {
    const outline = outlineOf(articleOf(section("s", heading(2, "h", "两字") + "<p>三 个 词</p>")));
    const [first] = outline.nodes;

    expect(first?.wordCount).toBe(5);
    expect(first?.children[0]?.wordCount).toBe(2);
    expect(outline.wordCount).toBe(5);
  });

  // 已登记缺陷：`firstArticleOf` 在 LIFO 栈上按文档序 push，实际先看到**最后一个** article。
});
describe("hr_outline · 结构 · 续 3 · 续 1", () => {
  // KD-04
  it.fails("should outline the first article when a document has several", () => {
    const outline = outlineOf(
      `${articleOf(heading(1, "a1", "第一"))}${articleOf(heading(1, "a2", "第二"))}`,
    );

    expect(shapeOf(outline.nodes)).toEqual([["a1", "h1", 1, "第一", []]]);
  });

  // 同一缺陷的现状钉子：修好后这条会红，提醒把上一条 `it.fails` 翻牌。
});
describe("hr_outline · 结构 · 续 4", () => {
  it("should expose the current last-article selection (D3 pin)", () => {
    const outline = outlineOf(
      `${articleOf(heading(1, "a1", "第一"))}${articleOf(heading(1, "a2", "第二"))}`,
    );

    expect(shapeOf(outline.nodes)).toEqual([["a2", "h1", 1, "第二", []]]);
    expect(codesOf(outline), "outline 不跑 validate，multiple_article 不在这层").toEqual([]);
  });
});

describe("hr_outline · 深度上限（结构裁剪）", () => {
  const nestedSections = (depth: number): string => {
    let html = '<article data-hr-id="doc">';
    for (let level = 1; level <= depth; level += 1) {
      html += `<section data-hr-id="s${String(level)}"><h2 data-hr-id="h${String(level)}">第 ${String(level)} 层</h2>`;
    }
    return `${html}${"</section>".repeat(depth)}</article>`;
  };

  it("should cut nodes below the depth limit and report it once", () => {
    const outline = outlineOf(nestedSections(6));
    const truncated = outline.diagnostics.filter((item) => item.code === "outline_truncated");

    expect(truncated.length).toBe(1);
    expect(truncated[0]?.message).toMatch(/命中结构\/文本上限 \d+ 处$/u);
    expect(depthOf(outline.nodes)).toBe(4);
  });

  it("should keep exactly the four shallowest levels and drop the rest", () => {
    const outline = outlineOf(nestedSections(6));

    // 第 4 层的 `<h4>` 位于第 5 层深度，已被裁掉：只留 s1..s4 与其 h1..h3。
    expect(idsOf(outline.nodes)).toEqual(["s1", "h1", "s2", "h2", "s3", "h3", "s4"]);
  });
});
