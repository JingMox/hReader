// 这层管：`hr_read_node` 的截断语义（可进入判定、最小可行字节、码点边界、可回读）；不测选择器与外壳判定。

import { describe, expect, it } from "vitest";

import { parseHtml, readNode } from "../src/index";

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

const read = (html: string, target: string, maxBytes?: number): ReturnType<typeof readNode> =>
  maxBytes === undefined
    ? readNode(parseHtml(html), target)
    : readNode(parseHtml(html), target, maxBytes);

const codeOf = (html: string, target: string, maxBytes: number): string => {
  try {
    read(html, target, maxBytes);
  } catch (error) {
    return error instanceof Error && "code" in error
      ? String(Reflect.get(error, "code"))
      : "no-throw";
  }
  return "no-throw";
};

/** 标签配对栈校验：比 `parseHtml` 不抛更强，能抓到"闭合标签被吃掉"的错。 */
const expectBalanced = (html: string, tag: string): void => {
  const opens = html.split(new RegExp(`<${tag}(?=[\\s>])`, "g")).length - 1;
  const closes = html.split(`</${tag}>`).length - 1;

  expect(closes).toBe(opens);
};

const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

describe("truncate · the 64KB default and its boundary", () => {
  const filler = (length: number): string =>
    `<section data-hr-id="s1">${"文".repeat(Math.floor(length / 3))}</section>`;

  it("should not truncate a subtree below the default limit", () => {
    const result = read(`<article data-hr-id="post">${filler(3_000)}</article>`, "#s1");

    expect(result.truncated).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      "truncated_output",
    );
  });

  it("should truncate exactly at the default limit and keep the open tag", () => {
    const result = read(`<article data-hr-id="post">${filler(70_000)}</article>`, "#s1");

    expect(result.truncated).toBe(true);
    expect(byteLength(result.html)).toBeLessThanOrEqual(65_536);
    expect(result.html.startsWith('<section data-hr-id="s1">')).toBe(true);
    expectBalanced(result.html, "section");
  });

  it("should honour an explicit limit one byte below the payload", () => {
    const payload = '<section data-hr-id="s1">abcd</section>';

    expect(read(payload, "#s1", byteLength(payload)).truncated).toBe(false);
    const short = read(payload, "#s1", byteLength(payload) - 1);

    expect(short.truncated).toBe(true);
    expect(byteLength(short.html)).toBeLessThanOrEqual(byteLength(payload) - 1);
  });
});

const readIn = (html: string, target: string, maxBytes: number): ReturnType<typeof readNode> =>
  read(html, target, maxBytes);

describe("truncate · minimum feasible size", () => {
  it("should reject one byte below open tag + closing tag", () => {
    expect(codeOf('<section data-hr-id="s1">x</section>', "#s1", 34)).toBe("invalid_max_bytes");
  });

  it("should accept exactly open tag + closing tag and keep an empty shell", () => {
    const result = readIn('<section data-hr-id="s1">x</section>', "#s1", 35);

    expect(result.html).toBe('<section data-hr-id="s1"></section>');
    expect(result.truncated).toBe(true);
    expectBalanced(result.html, "section");
  });

  it("should name the minimum in the error message", () => {
    const thrown = (() => {
      try {
        readIn('<section data-hr-id="s1">x</section>', "#s1", 10);
      } catch (error) {
        return error;
      }
      return undefined;
    })();

    expect(thrown).toHaveProperty("code", "invalid_max_bytes");
    expect(thrown).toHaveProperty("message", "maxBytes 过小：<section> 至少需要 35 字节，收到 10");
  });

  it("should count only the open tag for a void root", () => {
    expect(readIn("<p>a<br>b</p>", "br", 4)).toMatchObject({ html: "<br>", truncated: false });
    expect(codeOf("<p>a<br>b</p>", "br", 3)).toBe("invalid_max_bytes");
  });
});

/** 截断后落在目标元素里的那截文本（用标签首尾定位，不依赖解析器）。 */
const bodyOf = (html: string): string =>
  html.slice(html.indexOf(">") + 1, html.indexOf("</section>"));

const expectCodepointClean = (html: string, budget: number): void => {
  const result = readIn(html, "#s1", budget);

  expect(bodyOf(result.html)).not.toMatch(loneSurrogate);
  expect(parseHtml(result.html).diagnostics).toEqual([]);
  expectBalanced(result.html, "section");
};

describe("truncate · codepoint boundaries", () => {
  // 预算扫全区间：只测一个大预算会“恰好落在偶数边界”而放过按 UTF-16 码元切的实现。
  const budgetsFrom = (minimum: number): number[] =>
    Array.from({ length: 40 }, (_, index) => minimum + index);

  it("should never emit a lone surrogate for any budget", () => {
    const html = `<section data-hr-id="s1">${"😀".repeat(4_000)}</section>`;

    for (const budget of budgetsFrom(35)) {
      expectCodepointClean(html, budget);
    }
  });

  // D-P2（见报告）：只在码点边界停手，NFD 的 `e`+U+0301 会被切出“没带重音的空壳 e”。
  // KD-05
  it.fails("should never leave an orphan combining mark for any budget", () => {
    const nfd = "e\u0301".repeat(2_000);
    const html = `<section data-hr-id="s1">${nfd}</section>`;

    for (const budget of budgetsFrom(45)) {
      const result = readIn(html, "#s1", budget);
      const body = result.html.slice(
        result.html.indexOf(">") + 1,
        result.html.indexOf("</section>"),
      );

      expect(body).toMatch(/^(?:e\u0301)*$/u);
    }
  });

  it("should keep CJK text whole and re-parseable", () => {
    const result = readIn(`<section data-hr-id="s1">${"汉".repeat(2_000)}</section>`, "#s1", 901);

    expect(result.truncated).toBe(true);
    expect(byteLength(result.html)).toBeLessThanOrEqual(901);
    expect(parseHtml(result.html).diagnostics).toEqual([]);
    expectBalanced(result.html, "section");
  });
});

describe("truncate · multi-codepoint clusters", () => {
  it("should keep the ZWJ text free of lone surrogates and re-parseable", () => {
    const result = readIn(`<section data-hr-id="s1">${"👨‍👩‍👧‍👦".repeat(600)}</section>`, "#s1", 2003);

    expect(result.truncated).toBe(true);
    expect(bodyOf(result.html)).not.toMatch(loneSurrogate);
    expect(parseHtml(result.html).diagnostics).toEqual([]);
    expectBalanced(result.html, "section");
  });

  // D-族（P2，见报告）：截断只在码点边界停手，ZWJ 家族会被切出"半个家庭"。
  // KD-05
  it.fails("should never cut a ZWJ family apart", () => {
    const result = readIn(`<section data-hr-id="s1">${"👨‍👩‍👧‍👦".repeat(600)}</section>`, "#s1", 2003);

    expect(Array.from(bodyOf(result.html)).length % Array.from("👨‍👩‍👧‍👦").length).toBe(0);
  });

  it("should never leave a combining mark without its base", () => {
    const result = readIn(`<section data-hr-id="s1">${"é".repeat(9_000)}</section>`, "#s1", 2003);
    const body = result.html.slice(result.html.indexOf(">") + 1, result.html.indexOf("</section>"));

    expect(result.truncated).toBe(true);
    expect(body).toMatch(/^(?:é)*$/u);
    expectBalanced(result.html, "section");
  });
});

describe("truncate · enterable elements (v2 #10)", () => {
  const big = (count: number): string =>
    `<article data-hr-id="post">${Array.from(
      { length: count },
      (_, index) => `<section data-hr-id="s${String(index)}">${"文".repeat(400)}</section>`,
    ).join("")}</article>`;

  it("should enter a child that does not fit instead of emptying the parent", () => {
    const result = readIn(big(6), "article", 600);

    expect(result.truncated).toBe(true);
    expect(result.html.startsWith('<article data-hr-id="post">')).toBe(true);
    expect(result.html).toContain("<section");
    expect(result.html.endsWith("</article>")).toBe(true);
    expect(byteLength(result.html)).toBeLessThanOrEqual(600);
    expectBalanced(result.html, "section");
  });

  it("should keep every section whole when the budget covers all of them", () => {
    const html = big(3);
    const result = readIn(html, "article", byteLength(html));

    expect(result.truncated).toBe(false);
    expect(result.html).toBe(html);
  });
});

describe("truncate · atomic leaves", () => {
  it("should drop a comment atomically when it cannot fit", () => {
    const result = readIn(`<p>${"a".repeat(200)}<!-- ${"c".repeat(200)} --></p>`, "p", 120);

    expect(result.truncated).toBe(true);
    expect(result.html).not.toContain("<!--");
    expectBalanced(result.html, "p");
  });

  it("should drop an oversized comment leaf without opening the parent twice", () => {
    const html = `<p data-hr-id="p">x<!-- ${"c".repeat(3_000)} --></p>`;
    const result = readIn(html, "p", 40);

    expect(result.html).toBe('<p data-hr-id="p">x</p>');
    expect(result.truncated).toBe(true);
    expect(result.html).not.toContain("<!--");
  });

  it("should escape the budget measurement on the serialized form", () => {
    // 预算 10B：原文能放 10 个 `&`，序列化后每个是 `&amp;`（5B），所以只容得下 2 个。
    const result = readIn(`<section data-hr-id="s1">${"&".repeat(100)}</section>`, "#s1", 45);

    expect(result.html).toBe('<section data-hr-id="s1">&amp;&amp;</section>');
    expect(result.truncated).toBe(true);
  });
});

describe("truncate · invalid maxBytes", () => {
  it("should refuse an integer below the minimum", () => {
    expect(codeOf("<p>正文</p>", "p", 1)).toBe("invalid_max_bytes");
  });

  it("should refuse zero and negatives", () => {
    expect(codeOf("<p>正文</p>", "p", 0)).toBe("invalid_max_bytes");
    expect(codeOf("<p>正文</p>", "p", -1)).toBe("invalid_max_bytes");
  });

  it("should refuse a fractional value", () => {
    expect(codeOf("<p>正文</p>", "p", 1.5)).toBe("invalid_max_bytes");
  });

  it("should refuse more than 16MB", () => {
    expect(codeOf("<p>正文</p>", "p", 16 * 1024 * 1024 + 1)).toBe("invalid_max_bytes");
  });
});

describe("truncate · diagnostics", () => {
  it("should say the original size is measured after serialization", () => {
    const result = readIn(`<p>${"a".repeat(500)}</p>`, "p", 20);

    expect(result.truncated).toBe(true);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["truncated_output"]);
    expect(result.diagnostics[0]?.message).toContain("（序列化后）");
    expect(result.diagnostics[0]?.message).toContain("/ 上限 20 字节");
  });

  it("should never report truncated_output while returning truncated:false", () => {
    const result = readIn("<p>短</p>", "p", 100);

    expect(result.truncated).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      "truncated_output",
    );
  });
});

describe("truncate · a non-empty prefix is still a partial read (v3 #20)", () => {
  // v3 #20 删掉了 `truncate.ts` 里“前缀放不下就 none”的死臂；这条把新暴露的 `"partial"` 路径锁住。
  it("should keep the open tag plus a non-empty text prefix instead of collapsing to a shell", () => {
    const html = `<section data-hr-id="s1">${"文".repeat(8)}</section>`;
    const minimal = 35;
    const result = readIn(html, "#s1", minimal + 10);

    expect(result.truncated).toBe(true);
    expect(bodyOf(result.html).length).toBeGreaterThan(0);
    expect(bodyOf(result.html).length).toBeLessThan(8);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["truncated_output"]);
    expectBalanced(result.html, "section");
    expect(parseHtml(result.html).diagnostics).toEqual([]);
  });
});
