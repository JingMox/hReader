// 这层管：`importForeign` 的对抗面——剥离计数的精确口径、标题去重、产物不再有执行面。

import { describe, expect, it } from "vitest";

import { classifyDocument, importForeign, parseHtml } from "../../src/index";

describe("importForeign · 剥离计数精确口径", () => {
  it("should count each dropped element once at its outermost node and each stripped attribute once", () => {
    const result = importForeign(
      `<!doctype html><html><head><title>t</title><script>a</script><style>b</style></head>` +
        `<body><main>` +
        `<p onclick="x" style="color:red" data-hr-id="fake">段</p>` +
        `<script>c</script>` +
        `<button onclick="y">按钮</button>` +
        `<form><input><select></select></form>` +
        `</main></body></html>`,
    );

    // 元素整删（最外层计一次）：
    // - head 一项（装了 script/style → meaningful head，整体算"主干之外"，子树不再逐项计）
    // - main 内 script×1、button×1、form×1（button 的 onclick 与 form 的 input/select 随整删不计）
    // p 上剥 3 个属性：onclick / style / data-hr-id
    expect(result.report.strippedAttributes).toBe(3);
    expect(result.report.removedElements).toBe(4);
    const discarded = Object.fromEntries(
      result.report.discarded.map((entry) => [entry.what, entry.count]),
    );
    expect(discarded["head"]).toBe(1);
    expect(discarded["script"]).toBe(1);
    expect(discarded["属性 on*"]).toBe(1);
    expect(discarded["属性 style"]).toBe(1);
    expect(discarded["属性 data-hr-*"]).toBe(1);
  });

  it("should not double-count nested dropped elements or their inner attributes", () => {
    const result = importForeign(
      `<body><main><form action="javascript:x"><button onclick="y"><input></button></form></main></body>`,
    );

    // form 整删一次；button/input 与全部属性都不再出现——删除不递归计数。
    expect(result.report.removedElements).toBe(1);
    expect(result.report.strippedAttributes).toBe(0);
  });
});

describe("importForeign · 标题去重", () => {
  it("should not render the same text twice when <title> and the first <h1> agree", () => {
    const result = importForeign(
      `<html><head><title>文章标题</title></head><body><main><h1>文章标题</h1><p>正文</p></main></body></html>`,
    );

    expect(result.report.title).toBe("文章标题");
    expect(result.report.titleSource).toBe("title");
    // 同一串文字既当文档 h1 又当第一节 h2 是纯重复——h1 应被标题吃掉，不管它有没有供出标题。
    expect(result.html.match(/<h[12][ >]/gu)?.length).toBe(1);
    expect(result.html).not.toContain(">文章标题</h2>");
  });

  it("should keep a first h1 whose text differs from the title", () => {
    const result = importForeign(
      `<html><head><title>网站名 - 文章标题</title></head><body><main><h1>文章标题</h1><p>正文</p></main></body></html>`,
    );

    expect(result.report.title).toBe("网站名 - 文章标题");
    expect(result.html).toContain(">网站名 - 文章标题</h1>");
    expect(result.html).toContain(">文章标题</h2>");
  });
});

describe("importForeign · 产物无执行面", () => {
  it("should leave no script-capable markup in the product for a hostile body", () => {
    const hostile =
      `<body><main>` +
      `<a href="javascript:alert(1)">链</a>` +
      `<a href="data:text/html,<script>x</script>">链2</a>` +
      `<form action="javascript:x"><input></form>` +
      `<p><img src="https://evil/x.png" srcset="https://evil/a.png 1x"></p>` +
      `<p onclick="x" style="background:url(//evil)">段</p>` +
      `<svg><a xlink:href="javascript:x"><text>t</text></a></svg>` +
      `</main></body>`;
    const result = importForeign(hostile);
    const reparsed = parseHtml(result.html);

    expect(classifyDocument(reparsed).cls).toBe("managed");
    expect(result.html).not.toContain("javascript:");
    expect(result.html).not.toContain("data:text/html");
    expect(result.html).not.toContain("onclick");
    expect(result.html).not.toContain("https://evil");
  });

  it("should produce a byte-identical product for the same hostile input", () => {
    const hostile = `<body><main><a href="javascript:x">a</a><p onclick="y">b</p></main></body>`;

    expect(importForeign(hostile).html).toBe(importForeign(hostile).html);
  });
});
