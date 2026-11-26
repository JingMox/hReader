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

describe("cover title resolution", () => {
  it("should prefer an explicit title", () => {
    const html = printHtmlOf(inputOf(fixtureOf("article.html"), { title: "自定义标题" }));
    expect(coverTitleOf(html)).toBe("自定义标题");
    expect(html).toContain("<title>自定义标题</title>");
  });

  it("should fall back to the <title> text when no explicit title is given", () => {
    expect(coverTitleOf(printHtmlOf(inputOf(fixtureOf("article.html"))))).toBe("季度技术评述");
  });

  it("should fall back to the first body <h1> when there is no <title>", () => {
    const html = printHtmlOf(
      inputOf(fixtureOf("article.html").replace("<title>季度技术评述</title>", "")),
    );
    expect(coverTitleOf(html)).toBe("季度技术评述");
  });

  it("should emit an empty title when all four candidates are empty (docId included)", () => {
    const html = printHtmlOf(
      inputOf('<article data-hr-id="a"><p>只有正文。</p></article>', { docId: "" }),
    );
    expect(html).toContain('<p class="cover__title"></p>');
  });

  it("should fall back to docId when there is not even an <h1>", () => {
    const html = printHtmlOf(
      inputOf("<article><h2>二级标题</h2><p>正文。</p></article>", { docId: "fallback-name" }),
    );
    expect(coverTitleOf(html)).toBe("fallback-name");
  });
});

describe("same-level siblings and comments", () => {
  it("should give two same-level h1s their own chapters (the top count never reuses another's child count)", () => {
    const html = printHtmlOf(
      inputOf("<article><h1>甲</h1><p>一。</p><h1>乙</h1><h2>乙一</h2></article>"),
    );
    const nums = tagsOf(parseHtml(html).root, "span")
      .filter((span) => classesOf(span).includes("secnum"))
      .map((span) => textOf(span).trim());
    expect(nums).toEqual(["1", "2", "2.1"]);
  });

  it("should not count a comment inside a heading as body text", () => {
    const html = printHtmlOf(inputOf("<article><h1>带注释的标题<!-- 内部备注 --></h1></article>"));
    expect(coverTitleOf(html)).toBe("带注释的标题");
  });
});

describe("4 MiB limit", () => {
  const LIMIT = 4 * 1024 * 1024;
  /** Pad with one `a` to start: an empty paragraph hits `empty_document` before any byte counting happens. */
  const bytesWithPadOf = (pad: number): number =>
    printHtmlReportOf(inputOf(`<article><p>${"a".repeat(pad + 1)}</p></article>`)).bytes;
  const offset = bytesWithPadOf(0);

  it("should produce normally at limit-1 bytes with bytes matching the real size", () => {
    const pad = LIMIT - 1 - offset;
    const report = printHtmlReportOf(inputOf(`<article><p>${"a".repeat(pad + 1)}</p></article>`));
    expect(report.bytes).toBe(LIMIT - 1);
    expect(report.bytes).toBe(Buffer.byteLength(report.html, "utf8"));
  }, 30_000);

  it("should accept exactly limit bytes as valid output (the contract rejects > 4 MiB, not >=)", () => {
    const pad = LIMIT - offset;
    const report = printHtmlReportOf(inputOf(`<article><p>${"a".repeat(pad + 1)}</p></article>`));
    expect(report.bytes).toBe(LIMIT);
    expect(report.bytes).toBe(Buffer.byteLength(report.html, "utf8"));
  }, 30_000);

  it("should throw invalid_input at limit+1 before assembly (not assemble-then-check)", () => {
    const html = `<article><p>${"a".repeat(LIMIT + 2 - offset)}</p></article>`;
    expect(codeOf(() => printHtmlOf(inputOf(html)))).toBe("invalid_input");
  }, 30_000);
});

describe("escaping", () => {
  it("should escape tags in the title so they cannot become executable markup", () => {
    const html = printHtmlOf(
      inputOf(fixtureOf("article.html"), { title: "<script>alert(1)</script>" }),
    );
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script");
  });

  it("should re-escape angle brackets and & in body text", () => {
    const html = printHtmlOf(inputOf("<article><p>5 &lt; 6 &amp; 7</p></article>"));
    expect(html).toContain("5 &lt; 6 &amp; 7");
  });
});

describe("determinism", () => {
  const input = inputOf(fixtureOf("article.html"));

  it("should produce identical bytes for two calls with the same input", () => {
    expect(printHtmlOf(input)).toBe(printHtmlOf(input));
  });

  it("should produce the same bytes for a reassembled equivalent input", () => {
    expect(printHtmlOf(inputOf(fixtureOf("article.html")))).toBe(printHtmlOf(input));
  });

  it("should contain no cwd, hostname, or timestamp in the product", () => {
    const html = printHtmlOf(input);
    expect(html).not.toContain(process.cwd());
    expect(html).not.toContain(hostname());
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}/u);
  });
});

describe("empty sheets and missing body", () => {
  it("should throw empty_document when article exists but trimming leaves no text", () => {
    expect(codeOf(() => printHtmlOf(inputOf(fixtureOf("article-empty.html"))))).toBe(
      "empty_document",
    );
  });

  it("should throw empty_document for empty-section shells with no text (text-level check)", () => {
    expect(codeOf(() => printHtmlOf(inputOf(fixtureOf("article-structure-only.html"))))).toBe(
      "empty_document",
    );
  });

  it("should throw empty_document for inline images without text (even legal images are not body)", () => {
    expect(codeOf(() => printHtmlOf(inputOf(fixtureOf("article-image-only.html"))))).toBe(
      "empty_document",
    );
  });

  it("should count zero-width-only content as empty (U+200B takes no room on paper and trim() misses it)", () => {
    const html = "<article><p>\u200B\uFEFF\u180E</p></article>";
    expect(codeOf(() => printHtmlOf(inputOf(html)))).toBe("empty_document");
  });
});

describe("zero-width characters and edge cases", () => {
  it("should not count zero-width characters sandwiched in real text as empty", () => {
    const html = printHtmlOf(inputOf("<article><p>\u200B真文字\uFEFF</p></article>"));
    expect(html).toContain("真文字");
  });

  it("should not report empty when a document has a heading but no body", () => {
    const html = printHtmlOf(inputOf(fixtureOf("article-heading-only.html")));
    expect(html).toContain("只有标题");
  });

  it("should throw no_article when the source document has no <article>", () => {
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

describe("theme CSS", () => {
  const themed = printHtmlOf(
    inputOf(fixtureOf("article.html"), { themeCss: ".cover__title { color: red; }" }),
  );

  it("should inline the full theme text into the theme <style> in head", () => {
    expect(themed).toContain('<style class="hr-theme">.cover__title { color: red; }</style>');
  });

  it("should order theme before print skeleton so the skeleton wins at equal specificity", () => {
    const themeAt = themed.indexOf('<style class="hr-theme">');
    const printAt = themed.indexOf('<style class="hr-print">');
    expect(themeAt).toBeGreaterThan(-1);
    expect(printAt).toBeGreaterThan(themeAt);
    expect(themed.indexOf("</head>")).toBeGreaterThan(printAt);
  });

  it("should escape a </style inside the theme already at the print layer", () => {
    const escaped = printHtmlOf(
      inputOf(fixtureOf("article.html"), { themeCss: "p{color:red}</STYLE><script>x</script>" }),
    );
    const escapedRoot = parseHtml(escaped).root;
    // The escape never reaches the tag layer: after parsing there are still only our two style tags and no script element.
    expect(tagsOf(escapedRoot, "style").length).toBe(2);
    expect(tagsOf(escapedRoot, "script")).toEqual([]);
    expect(escaped).toContain("<\\/STYLE>");
  });
});

describe("nesting depth limit", () => {
  const deepDoc = (depth: number): string =>
    `<article data-hr-id="r">${"<div>".repeat(depth)}x${"</div>".repeat(depth)}</article>`;

  it("should throw invalid_document rather than a bare RangeError when nesting exceeds the limit", () => {
    expect(codeOf(() => printHtmlOf(inputOf(deepDoc(2100))))).toBe("invalid_document");
  });

  it("should produce normally for a deep document within the limit", () => {
    const html = printHtmlOf(inputOf(deepDoc(2000)));
    expect(html).toContain("<article");
  });
});
