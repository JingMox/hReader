import { parseHtml } from "@hreader/core";
import { hostname } from "node:os";
import { describe, expect, it } from "vitest";

import { HrError } from "@hreader/core";

import { printHtmlOf, printHtmlReportOf } from "../src/index";
import type { PrintHtmlInput } from "../src/index";
import { classesOf, fixtureOf, firstTagOf, inputOf, tagsOf, textOf } from "./support";

const coverTitleOf = (html: string): string => textOf(firstTagOf(parseHtml(html).root, "p")).trim();

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return error instanceof HrError ? error.code : "not-hr-error";
  }
  return "no-throw";
};

describe("封面标题取值", () => {
  it("显式 title 优先", () => {
    const html = printHtmlOf(inputOf(fixtureOf("article.html"), { title: "自定义标题" }));
    expect(coverTitleOf(html)).toBe("自定义标题");
    expect(html).toContain("<title>自定义标题</title>");
  });

  it("没有显式 title 时取 <title> 文本", () => {
    expect(coverTitleOf(printHtmlOf(inputOf(fixtureOf("article.html"))))).toBe("季度技术评述");
  });

  it("没有 <title> 时取正文首个 <h1>", () => {
    const html = printHtmlOf(
      inputOf(fixtureOf("article.html").replace("<title>季度技术评述</title>", "")),
    );
    expect(coverTitleOf(html)).toBe("季度技术评述");
  });

  it("四级候选全空时标题为空串（docId 也空）", () => {
    const html = printHtmlOf(
      inputOf('<article data-hr-id="a"><p>只有正文。</p></article>', { docId: "" }),
    );
    expect(html).toContain('<p class="cover__title"></p>');
  });

  it("连 <h1> 都没有时回落 docId", () => {
    const html = printHtmlOf(
      inputOf("<article><h2>二级标题</h2><p>正文。</p></article>", { docId: "fallback-name" }),
    );
    expect(coverTitleOf(html)).toBe("fallback-name");
  });
});

describe("同名层级与注释", () => {
  it("两个同级 h1 各自成章（顶层计数不复用别人的子计数）", () => {
    const html = printHtmlOf(
      inputOf("<article><h1>甲</h1><p>一。</p><h1>乙</h1><h2>乙一</h2></article>"),
    );
    const nums = tagsOf(parseHtml(html).root, "span")
      .filter((span) => classesOf(span).includes("secnum"))
      .map((span) => textOf(span).trim());
    expect(nums).toEqual(["1", "2", "2.1"]);
  });

  it("标题里的注释不算正文文字", () => {
    const html = printHtmlOf(inputOf("<article><h1>带注释的标题<!-- 内部备注 --></h1></article>"));
    expect(coverTitleOf(html)).toBe("带注释的标题");
  });
});

describe("4 MiB 上限（§11.4）", () => {
  const LIMIT = 4 * 1024 * 1024;
  /** 垫一个 `a` 起步：空段落会先撞 `empty_document`，量不到字节数。 */
  const bytesWithPadOf = (pad: number): number =>
    printHtmlReportOf(inputOf(`<article><p>${"a".repeat(pad + 1)}</p></article>`)).bytes;
  const offset = bytesWithPadOf(0);

  it("limit-1 字节正常产出，bytes 与实际一致", () => {
    const pad = LIMIT - 1 - offset;
    const report = printHtmlReportOf(inputOf(`<article><p>${"a".repeat(pad + 1)}</p></article>`));
    expect(report.bytes).toBe(LIMIT - 1);
    expect(report.bytes).toBe(Buffer.byteLength(report.html, "utf8"));
  });

  it("恰好 limit 字节是合格产物（契约是 > 4 MiB 才拒，不是 >=", () => {
    const pad = LIMIT - offset;
    const report = printHtmlReportOf(inputOf(`<article><p>${"a".repeat(pad + 1)}</p></article>`));
    expect(report.bytes).toBe(LIMIT);
    expect(report.bytes).toBe(Buffer.byteLength(report.html, "utf8"));
  });

  it("limit+1 在拼接前抛 invalid_input（不是先拼完再判）", () => {
    const html = `<article><p>${"a".repeat(LIMIT + 2 - offset)}</p></article>`;
    expect(codeOf(() => printHtmlOf(inputOf(html)))).toBe("invalid_input");
  });
});

describe("转义", () => {
  it("标题里的标签被转义，不会变成可执行标签", () => {
    const html = printHtmlOf(
      inputOf(fixtureOf("article.html"), { title: "<script>alert(1)</script>" }),
    );
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script");
  });

  it("正文文本里的尖括号与 & 重新转义", () => {
    const html = printHtmlOf(inputOf("<article><p>5 &lt; 6 &amp; 7</p></article>"));
    expect(html).toContain("5 &lt; 6 &amp; 7");
  });
});

describe("确定性（D2）", () => {
  const input = inputOf(fixtureOf("article.html"));

  it("同一输入两次调用字节相同", () => {
    expect(printHtmlOf(input)).toBe(printHtmlOf(input));
  });

  it("重新装配的等价输入也产出同样的字节", () => {
    expect(printHtmlOf(inputOf(fixtureOf("article.html")))).toBe(printHtmlOf(input));
  });

  it("产物不含 cwd / 主机名 / 时间戳", () => {
    const html = printHtmlOf(input);
    expect(html).not.toContain(process.cwd());
    expect(html).not.toContain(hostname());
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}/u);
  });
});

describe("空稿与缺正文", () => {
  it("article 存在但裁完无文本 → empty_document", () => {
    expect(codeOf(() => printHtmlOf(inputOf(fixtureOf("article-empty.html"))))).toBe(
      "empty_document",
    );
  });

  it("只有空 section/空标签壳、没有文字 → empty_document（§12.1 文本级判据）", () => {
    expect(codeOf(() => printHtmlOf(inputOf(fixtureOf("article-structure-only.html"))))).toBe(
      "empty_document",
    );
  });

  it("只有内联图没有文字 → empty_document（图片再合法也不构成正文）", () => {
    expect(codeOf(() => printHtmlOf(inputOf(fixtureOf("article-image-only.html"))))).toBe(
      "empty_document",
    );
  });

  it("只有零宽字符也算空稿（U+200B 在纸面上不占位，trim() 又不认它，§13.2）", () => {
    const html = "<article><p>\u200B\uFEFF\u180E</p></article>";
    expect(codeOf(() => printHtmlOf(inputOf(html)))).toBe("empty_document");
  });
});

describe("零宽字符与边界", () => {
  it("零宽字符夹在真文字里不算空", () => {
    const html = printHtmlOf(inputOf("<article><p>\u200B真文字\uFEFF</p></article>"));
    expect(html).toContain("真文字");
  });

  it("只有标题没有正文不许报空", () => {
    const html = printHtmlOf(inputOf(fixtureOf("article-heading-only.html")));
    expect(html).toContain("只有标题");
  });

  it("源文档没有 <article> → no_article", () => {
    const input: PrintHtmlInput = {
      docId: "x",
      visualId: "v",
      paper: "a4",
      documentHtml: "<p>没有正文容器</p>",
      themeCss: "",
      outline: [],
    };
    expect(codeOf(() => printHtmlOf(input))).toBe("no_article");
  });
});

describe("主题 CSS", () => {
  const themed = printHtmlOf(
    inputOf(fixtureOf("article.html"), { themeCss: ".cover__title { color: red; }" }),
  );

  it("主题全文内联进 head 的主题 <style>", () => {
    expect(themed).toContain('<style class="hr-theme">.cover__title { color: red; }</style>');
  });

  it("主题在前、印刷骨架在后：同特异度时骨架压主题（§13.4）", () => {
    const themeAt = themed.indexOf('<style class="hr-theme">');
    const printAt = themed.indexOf('<style class="hr-print">');
    expect(themeAt).toBeGreaterThan(-1);
    expect(printAt).toBeGreaterThan(themeAt);
    expect(themed.indexOf("</head>")).toBeGreaterThan(printAt);
  });

  it("主题里的 </style 逃逸在打印层就被转义（§12.3）", () => {
    const escaped = printHtmlOf(
      inputOf(fixtureOf("article.html"), { themeCss: "p{color:red}</STYLE><script>x</script>" }),
    );
    const escapedRoot = parseHtml(escaped).root;
    // 逃逸串进不了标签层：解析后仍然只有我们这两份 style，且没有任何 script 元素。
    expect(tagsOf(escapedRoot, "style").length).toBe(2);
    expect(tagsOf(escapedRoot, "script")).toEqual([]);
    expect(escaped).toContain("<\\/STYLE>");
  });
});
