// 这层管：`importForeign` 的外来 → 托管转换——主干选择、import 剥离、分节、标题来源、确定性与产物自证。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  checkLayout,
  classifyDocument,
  importForeign,
  parseHtml,
  validateDocument,
  type ImportReport,
} from "../src/index";

const REPO = join(import.meta.dirname, "../../..");

const reportOf = (html: string, options?: Parameters<typeof importForeign>[1]): ImportReport =>
  importForeign(html, options).report;

const errorOf = (html: string): { code: string; message: string } => {
  try {
    importForeign(html);
  } catch (error: unknown) {
    const failed = error as { code?: string; message?: string };
    return { code: String(failed.code), message: String(failed.message) };
  }
  throw new Error("预期 importForeign 抛错");
};

describe("importForeign · 主干选择", () => {
  it("should pick <main> over a dominant sibling", () => {
    const report = reportOf(
      "<body><div>导航模板导航模板导航模板</div><main><p>正文</p></main></body>",
    );

    expect(report.trunk).toBe("main");
    expect(report.trunkTag).toBeUndefined();
  });

  it("should pick the dominant body subtree when there is no <main>", () => {
    // 支配者排在第二也能赢（比较的是文本量不是次序）；空白/无文本子树不当候选。
    const report = reportOf(
      '<body><div>小</div><div id="content"><p>正文比其它兄弟加起来都长得多得多</p></div>' +
        "<div></div><nav>菜单</nav></body>",
    );

    expect(report.trunk).toBe("largest");
    expect(report.trunkTag).toBe("div");
    expect(importForeign("<body><nav>菜单</nav><div><p>正文更长</p></div></body>").html).toContain(
      "正文更长",
    );
  });

  it("should fall back to <body> when no single subtree dominates", () => {
    const report = reportOf(
      "<body><section>第一页内容</section><section>第二页内容</section></body>",
    );

    expect(report.trunk).toBe("body");
    expect(report.sections).toBe(1);
  });

  it("should fall back to <body> and report zero sections when the document is empty", () => {
    const report = reportOf("");

    expect(report.trunk).toBe("body");
    expect(report.sections).toBe(0);
  });

  it("should count out-of-trunk elements once at their outermost node", () => {
    // head（装着 script）、trunk 的前后兄弟各计一次"主干之外"，子孙不重复计。
    const { report } = importForeign(
      "<html><head><title>t</title><script>boot()</script></head>" +
        "<body><nav>菜单</nav><main><p>正文</p></main><footer>页脚</footer></body></html>",
    );
    const whatOf = (name: string) => report.discarded.find((entry) => entry.what === name);

    expect(whatOf("head")).toMatchObject({ reason: "主干之外（文档头与页面框架）", count: 1 });
    expect(whatOf("nav")?.reason).toBe("主干之外（文档头与页面框架）");
    expect(whatOf("footer")?.reason).toBe("主干之外（文档头与页面框架）");
    expect(whatOf("script")).toBeUndefined();
  });

  it("should not count a head holding only title and meta", () => {
    const { report } = importForeign(
      '<html><head><title>t</title><meta charset="utf-8"></head>' +
        "<body><main><p>正文</p></main></body></html>",
    );

    expect(report.discarded.every((entry) => entry.what !== "head")).toBe(true);
  });
});

describe("importForeign · 剥离", () => {
  it("should drop executable and non-content elements with reasons", () => {
    const html =
      '<body><main><script>alert(1)</script><style>.a{}</style><iframe src="x"></iframe>' +
      "<form><input></form><video></video><noscript>n</noscript>" +
      "<p>留下</p><!-- 批注 --></main></body>";
    const { html: out, report } = importForeign(html);
    const whatOf = (name: string) => report.discarded.find((entry) => entry.what === name);

    expect(out).toContain("留下");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert");
    expect(whatOf("script")).toMatchObject({ reason: "可执行脚本", count: 1 });
    expect(whatOf("style")?.reason).toBe("样式或资源声明");
    expect(whatOf("iframe")?.reason).toBe("嵌入内容");
    expect(whatOf("form")?.reason).toBe("交互控件");
    expect(whatOf("video")?.reason).toBe("外部媒体");
    expect(whatOf("noscript")?.reason).toBe("隐藏或原始文本壳");
    expect(whatOf("注释")).toMatchObject({ count: 1 });
  });

  it("should strip event handlers, inline styles, data-hr-* and interactive attributes", () => {
    const { html, report } = importForeign(
      '<body><main><p onclick="f()" style="color:red" data-hr-id="x" contenteditable hidden>t</p></main></body>',
    );
    const attrEntries = report.discarded.filter((entry) => entry.what.startsWith("属性 "));

    expect(report.strippedAttributes).toBe(5);
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("style=");
    expect(html).not.toContain('data-hr-id="x"');
    expect(attrEntries.map((entry) => entry.what)).toEqual(
      expect.arrayContaining(["属性 on*", "属性 style", "属性 data-hr-*", "属性 hidden"]),
    );
  });

  it("should keep local and inline images but drop external or src-less ones", () => {
    const { html, report } = importForeign(
      '<body><main><img src="a.png"><img src="data:image/png;base64,AAA">' +
        '<img src="https://x/b.png"><img src="//x/c.png"><img alt="d"></main></body>',
    );
    const dropped = report.discarded.filter((entry) => entry.what === "img");

    expect(html).toContain('<img src="a.png">');
    expect(html).toContain('src="data:image/png;base64,AAA"');
    expect(html).not.toContain("https://x/b.png");
    expect(dropped).toEqual([
      { what: "img", reason: "外链图片（只保留 data: 或相对路径）", count: 2 },
      { what: "img", reason: "缺少 src 的坏图", count: 1 },
    ]);
  });

  it("should drop SMIL animation, SVG resource refs and hReader UI residue", () => {
    const { html, report } = importForeign(
      '<body><main><p>正文</p><svg><animate attributeName="onload"/><use href="#x"/></svg>' +
        '<div data-hr-ui>面板</div><div class="hr-sidebar">侧栏</div></main></body>',
    );
    const whatOf = (name: string) => report.discarded.find((entry) => entry.what === name);

    expect(html).not.toContain("<svg");
    expect(whatOf("animate")?.reason).toBe("SMIL 动画");
    expect(whatOf("use")?.reason).toBe("SVG 外部资源引用");
    expect(whatOf("svg")?.reason).toBe("绘图语义");
    expect(whatOf("div")).toMatchObject({ reason: "hReader UI 残留", count: 2 });
  });

  it("should keep whitespace verbatim inside <pre>", () => {
    const { html } = importForeign("<body><main><pre>  line one\n  line two</pre></main></body>");

    expect(html).toContain("<pre data-hr-id=");
    expect(html).toContain("  line one\n  line two");
  });

  it("should drop decorative subtrees nested inside kept blocks", () => {
    const { html } = importForeign("<body><main><p>字<svg><circle/></svg>尾</p></main></body>");

    expect(html).not.toContain("<svg");
    expect(html).toContain("字");
  });

  it("should strip an external srcset while keeping a local one", () => {
    const { html } = importForeign(
      '<body><main><img src="a.png" srcset="a.png 1x"><img src="b.png" srcset="https://x/b.png 2x"></main></body>',
    );

    expect(html).toContain('srcset="a.png 1x"');
    expect(html).not.toContain("https://x/b.png 2x");
  });
});

describe("importForeign · 分节与形态", () => {
  it("should start a new section on h1 and h2 and demote section headings to h2", () => {
    const { html, report } = importForeign(
      "<body><div><h1>标题</h1><p>一</p><h2>第二节</h2><p>二</p><h3>小节</h3><p>三</p></div></body>",
      { title: "文档" },
    );

    expect(report.sections).toBe(2);
    expect(html).toContain("<h2 data-hr-id=");
    expect(html).toContain("<h3 data-hr-id=");
    expect(html).not.toContain("<section><h1");
  });

  it("should put preamble blocks into a leading section without a heading", () => {
    const { html, report } = importForeign(
      "<body><div><p>前言</p><h2>正题</h2><p>正文</p></div></body>",
    );

    expect(report.sections).toBe(2);
    expect(html).toContain("前言");
    expect(html.indexOf("前言")).toBeLessThan(html.indexOf("正题"));
  });

  it("should turn every h1/h2 into one slide section for kind slides", () => {
    const { html, report } = importForeign(
      "<body><div><h1>页一</h1><p>a</p><h2>页二</h2><p>b</p></div></body>",
      { kind: "slides", title: "deck" },
    );

    expect(report.kind).toBe("slides");
    expect(report.sections).toBe(2);
    expect(html).toContain('<article data-hr-id="root" data-hr-kind="slides">');
    // slides 骨架不包 .hr-layout：每页要占满视口。
    expect(html).not.toContain("hr-layout");
  });
});

describe("importForeign · 标题来源", () => {
  const SOURCE =
    "<html><head><title>页签标题</title></head><body><div><h1>大标题</h1><p>x</p></div></body></html>";

  it("should prefer the explicit option over everything else", () => {
    const report = reportOf(SOURCE, { title: "指定标题" });

    expect(report.title).toBe("指定标题");
    expect(report.titleSource).toBe("option");
  });

  it("should fall back to <title> when no option is given", () => {
    const report = reportOf(SOURCE);

    expect(report.title).toBe("页签标题");
    expect(report.titleSource).toBe("title");
  });

  it("should skip an empty <title> and fall through to the first h1", () => {
    const report = reportOf(
      "<html><head><title>  </title></head><body><div><h1>文档名</h1><p>正文</p></div></body></html>",
    );

    expect(report.title).toBe("文档名");
    expect(report.titleSource).toBe("h1");
  });

  it("should consume the first h1 when it supplies the title", () => {
    const { html, report } = importForeign("<body><div><h1>文档名</h1><p>正文</p></div></body>");

    expect(report.title).toBe("文档名");
    expect(report.titleSource).toBe("h1");
    // h1 被吃成文档标题：正文里只剩那一个 <h1>，不会重复出现一遍。
    expect(html.match(/<h1/gu)).toHaveLength(1);
  });

  it("should use the fallback title when nothing supplies one", () => {
    const report = reportOf("<body><p>只有正文</p></body>");

    expect(report.title).toBe("未命名");
    expect(report.titleSource).toBe("fallback");
  });

  it("should fall back when the first h1 normalizes to nothing", () => {
    const report = reportOf("<body><div><h1>   </h1><p>正文</p></div></body>");

    expect(report.title).toBe("未命名");
    expect(report.titleSource).toBe("fallback");
  });
});

describe("importForeign · 确定性与产物自证", () => {
  it("should produce byte-identical output for the same input", () => {
    const html = readFileSync(join(REPO, "fixtures/import/deck-foreign.html"), "utf8");

    expect(importForeign(html, { kind: "slides" }).html).toBe(
      importForeign(html, { kind: "slides" }).html,
    );
  });

  it("should classify the product as managed with no error diagnostics", () => {
    const html = readFileSync(join(REPO, "fixtures/import/deck-foreign.html"), "utf8");
    const { html: product, report } = importForeign(html, { kind: "slides" });
    const parsed = parseHtml(product);
    const errors = [...validateDocument(parsed), ...checkLayout(parsed.root)].filter(
      (issue) => issue.severity === "error",
    );

    expect(classifyDocument(parsed).cls).toBe("managed");
    expect(errors).toEqual([]);
    // 演示稿式输入：脚本 / SMIL 风险面 / 装饰 div 全清，页数与内容都对得上。
    expect(report.sections).toBe(3);
    expect(report.title).toBe("季度路演 · 内部版");
    expect(product).not.toContain("<script");
    expect(product).toContain("续约率 96%");
    expect(product).toContain('<img src="chart.png"');
  });

  it("should refuse to re-import an already managed document", () => {
    const { html: managed } = importForeign("<body><p>x</p></body>");
    const error = errorOf(managed);

    expect(error.code).toBe("invalid_input");
    expect(error.message).toContain("托管文档");
  });
});

describe("importForeign · 语义投影", () => {
  it("should unwrap unknown containers and fold inline runs into paragraphs", () => {
    const { html } = importForeign(
      '<body><div class="wrap"><section><p><span class="hl">高亮</span>与<code>code</code></p>' +
        "<div><b>独立</b></div></section></div></body>",
      { title: "t" },
    );

    expect(html).toContain("<p data-hr-id=");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<b>独立</b>");
    expect(html).not.toContain("<span");
    expect(html).not.toContain('class="wrap"');
    expect(html).not.toContain('class="hl"');
  });

  it("should drop chrome elements even when the trunk is <body>", () => {
    const { html } = importForeign(
      "<body><nav><a>菜单</a></nav><section>正文A</section><footer>页脚</footer><section>正文B</section></body>",
    );
    const parsed = parseHtml(html);

    expect(classifyDocument(parsed).cls).toBe("managed");
    expect(html).not.toContain("菜单");
    expect(html).not.toContain("页脚");
    expect(html).toContain("正文A");
  });
});
