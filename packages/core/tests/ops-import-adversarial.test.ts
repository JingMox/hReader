// 这层管：`importForeign` 的对抗面——剥离计数的精确口径、标题去重、产物不再有执行面。

import { describe, expect, it } from "vitest";

import { classifyDocument, importForeign, parseHtml } from "../src/index";

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

describe("importForeign · 丢弃原因文案按类归档", () => {
  // 报文进 report.discarded，是用户读得到的对外行为：每一类原因各喂一个元素，
  // 文案（reason）与归类（includes 数组成员）都得活着。
  const cases: readonly { readonly probe: string; readonly reason: string }[] = [
    { probe: "<script>go()</script>", reason: "可执行脚本" },
    { probe: '<svg><animate attributeName="x"/></svg>', reason: "SMIL 动画" },
    { probe: '<iframe src="//x"></iframe>', reason: "嵌入内容" },
    { probe: '<object data="x"></object>', reason: "嵌入内容" },
    { probe: '<embed src="x">', reason: "嵌入内容" },
    { probe: '<applet code="x"></applet>', reason: "嵌入内容" },
    { probe: "<style>p{color:red}</style>", reason: "样式或资源声明" },
    { probe: '<link rel="stylesheet" href="x.css">', reason: "样式或资源声明" },
    { probe: '<base href="//x">', reason: "样式或资源声明" },
    { probe: '<video src="//x.mp4"></video>', reason: "外部媒体" },
    { probe: '<audio src="//x.mp3"></audio>', reason: "外部媒体" },
    { probe: '<form action="/x"></form>', reason: "交互控件" },
    { probe: "<button>go</button>", reason: "交互控件" },
    { probe: '<input type="text">', reason: "交互控件" },
    { probe: "<select><option>1</option></select>", reason: "交互控件" },
    { probe: "<textarea>x</textarea>", reason: "交互控件" },
    { probe: "<template><b>x</b></template>", reason: "隐藏或原始文本壳" },
    { probe: "<noscript>x</noscript>", reason: "隐藏或原始文本壳" },
    { probe: '<svg><image href="//x.png"/></svg>', reason: "SVG 外部资源引用" },
    { probe: '<svg><use href="#x"/></svg>', reason: "SVG 外部资源引用" },
  ];

  it.each(cases)("should report %s as $reason", ({ probe, reason }) => {
    const result = importForeign(`<body><main><p>正文内容在这里。</p>${probe}</main></body>`);
    const reasons = result.report.discarded.map((entry) => entry.reason);

    expect(reasons).toContain(reason);
  });

  it("should report an hr-ui leftover under the catch-all reason", () => {
    const result = importForeign(
      '<body><main><p>正文内容在这里。</p><div class="hr-sidebar">x</div></main></body>',
    );

    expect(result.report.discarded.map((entry) => entry.reason)).toContain("hReader UI 残留");
  });

  it.each([
    { probe: '<p onclick="go()">x</p>', reason: "事件处理属性" },
    { probe: '<p style="color:red">x</p>', reason: "内联样式（长相归主题）" },
    { probe: '<p data-hr-tmp="1">x</p>', reason: "hReader 内部命名空间" },
    { probe: "<p hidden>x</p>", reason: "交互、隐藏或伪协议属性" },
  ])("should report stripped attr of $probe as $reason", ({ probe, reason }) => {
    const result = importForeign(`<body><main><p>正文内容在这里。</p>${probe}</main></body>`);
    const reasons = result.report.discarded.map((entry) => entry.reason);

    expect(reasons).toContain(reason);
  });
});

describe("importForeign · 主干选择", () => {
  it("should pick <main> as the trunk when present", () => {
    const result = importForeign("<body><main><p>正文</p></main><nav>菜单</nav></body>");

    expect(result.report.trunk).toBe("main");
  });

  it("should pick the largest text-heavy body child when no <main> exists", () => {
    const doc =
      "<body><nav>菜单链菜单链</nav>" +
      `<div>${"正文".repeat(80)}</div>` +
      "<footer>脚</footer></body>";
    const result = importForeign(doc);

    expect(result.report.trunk).toBe("largest");
    expect(result.report.trunkTag).toBe("div");
  });

  it("should fall back to body when nothing inside is eligible", () => {
    const result = importForeign("<body><nav>只有菜单</nav></body>");

    expect(result.report.trunk).toBe("body");
  });

  it("should ignore chrome wrappers when sizing candidates", () => {
    const doc =
      "<body>" +
      `<nav>${"菜单".repeat(120)}</nav>` +
      `<section>${"正文".repeat(10)}</section>` +
      "</body>";
    const result = importForeign(doc);

    // nav 文本量更大但不参选——否则主干会被框架吃掉。
    expect(result.report.trunk).toBe("largest");
    expect(result.report.trunkTag).toBe("section");
  });
});

describe("importForeign · 图片与 srcset 口径", () => {
  it("should drop an <img> with no src as a broken image", () => {
    const result = importForeign("<body><main><p>x</p><img alt='y'></main></body>");

    expect(result.html).not.toContain("<img");
    expect(result.report.discarded.map((e) => `${e.what}:${e.reason}`)).toContain(
      "img:缺少 src 的坏图",
    );
  });

  it("should drop an <img> whose src is external", () => {
    const result = importForeign(
      '<body><main><p>x</p><img src="//evil.example/x.png"></main></body>',
    );

    expect(result.html).not.toContain("<img");
    expect(result.report.discarded.map((e) => e.reason)).toContain(
      "外链图片（只保留 data: 或相对路径）",
    );
  });

  it("should strip srcset when any candidate is external", () => {
    const result = importForeign(
      '<body><main><p>x</p><img src="ok.png" srcset="ok.png 1x, //evil.example/x.png 2x"></main></body>',
    );

    expect(result.html).toContain("<img");
    expect(result.html).not.toContain("srcset");
    expect(result.report.discarded.map((e) => e.reason)).toContain("外链 srcset");
  });

  it("should keep srcset when every candidate is local", () => {
    const result = importForeign(
      '<body><main><p>x</p><img src="ok.png" srcset="ok.png 1x, ok2.png 2x"></main></body>',
    );

    expect(result.html).toContain("srcset");
  });
});
