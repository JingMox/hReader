// 这层管：sanitize 双预设的对抗测试——以"解析→裁切→序列化→浏览器再解析"整条链判风险，
// 不是只判单点决策。覆盖 mXSS、命名空间混淆、伪协议编码、raw-text 壳与幂等性。

import { parse as parse5 } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import { describe, expect, it } from "vitest";

import {
  hasExecutableContent,
  hasExternalResource,
  isDroppedNode,
  parseHtml,
  sanitizedAttributesOf,
  serializeHtml,
} from "../../src/index";
import type { HtmlElementNode, HtmlNode } from "../../src/index";
import type { SanitizePreset } from "../../src/index";

/**
 * 打印稿管线的等价裁切（print-html.ts 的判定组合）：整删命中 → 外链资源命中 → 剥属性。
 * 与 `ops/import` 的剥离层同构但不去壳/不投影——这里只测 sanitize 判定，不测 import 的块投影。
 */
const cleaned = (node: HtmlNode, preset: SanitizePreset): HtmlNode | undefined => {
  if (node.kind === "document") {
    return {
      kind: "document",
      children: node.children.flatMap((child) => {
        const kept = cleaned(child, preset);
        return kept === undefined ? [] : [kept];
      }),
    };
  }
  if (node.kind !== "element") return node;
  if (isDroppedNode(node, preset) || hasExternalResource(node, preset)) return undefined;
  const children = node.children.flatMap((child) => {
    const kept = cleaned(child, preset);
    return kept === undefined ? [] : [kept];
  });
  return {
    kind: "element",
    tag: node.tag,
    attrs: sanitizedAttributesOf(node, preset),
    children,
  };
};

const sanitizedToHtml = (html: string, preset: SanitizePreset): string => {
  const parsed = parseHtml(html);
  const root = cleaned(parsed.root, preset);
  return serializeHtml({
    root: root ?? { kind: "document", children: [] },
    diagnostics: [],
  });
};

/** 浏览器视角：`hr export`/`hr pdf` 的产物在开启脚本的浏览器里解析——`<noscript>` 是 raw text。 */
const browserParsedElements = (html: string): HtmlElementNode[] => {
  const document = parse5(html, { scriptingEnabled: true });
  const found: HtmlElementNode[] = [];
  const walk = (node: DefaultTreeAdapterTypes.Node): void => {
    if ("tagName" in node) {
      found.push({
        kind: "element",
        tag: node.tagName,
        attrs: node.attrs.map((attribute) => [
          attribute.name,
          attribute.value,
        ]) as HtmlElementNode["attrs"],
        children: [],
      });
    }
    const children =
      "childNodes" in node ? node.childNodes : "content" in node ? node.content.childNodes : [];
    for (const child of children ?? []) walk(child);
  };
  walk(document);
  return found;
};

const liveEventAttributes = (html: string): readonly string[] =>
  browserParsedElements(html).flatMap((element) =>
    element.attrs
      .filter(([name]) => name.toLowerCase().startsWith("on"))
      .map(([name, value]) => `${element.tag} ${name}=${value}`),
  );

const liveElements = (html: string, tag: string): number =>
  browserParsedElements(html).filter((element) => element.tag === tag).length;

describe("sanitize 对抗 · 已知疑点结论：<xmp> 文本透传", () => {
  const DOC = "<article><xmp><script>alert(1)</script></xmp><p>正文</p></article>";

  it("should keep <xmp> and pass its script-looking text through under print", () => {
    const out = sanitizedToHtml(DOC, "print");

    // 透传是事实：text 不转义（xmp 在 RAW_TEXT_TAGS）。这是本测试要记录的既有行为。
    expect(out).toContain("<xmp><script>alert(1)</script></xmp>");
  });

  it("should prove the xmp passthrough is inert when a browser re-parses it", () => {
    const out = sanitizedToHtml(DOC, "print");

    // 结论：不构成真实 XSS——`<xmp>` 在解析器与浏览器两侧都是 raw text，
    // 透传的是文本节点不是元素；且经解析器产出的 text 不可能含 `</xmp`（它在那里截断）。
    const elements = browserParsedElements(out);
    expect(elements.filter((element) => element.tag === "script")).toEqual([]);
    expect(liveEventAttributes(out)).toEqual([]);
  });
});

describe("sanitize 对抗 · <noscript> 的 raw-text 歧义（print 侧为已确认的冻结契约缺口，见汇报）", () => {
  // print 预设逐字节冻结：`<noscript>` 内容被解析成标记后序列化回 HTML，其中属性值/注释里
  // 的 `</noscript>` 会在脚本开启的浏览器里截断 raw text 造出活元素（mXSS）——修复要动
  // PRINT_DROPPED_TAGS 或序列化口径，字节必变 → 只记"import 侧已无此面"，缺口写进汇报需决策。
  it("should eliminate noscript raw-text ambiguity under import", () => {
    const hostile = '<noscript><p title="</noscript><img src=x onerror=alert(1)>">';
    const out = sanitizedToHtml(`<article>${hostile}</article>`, "import");

    expect(out).not.toContain("noscript");
    expect(liveEventAttributes(out)).toEqual([]);
  });
});

describe("sanitize 对抗 · 命名空间与二次入口", () => {
  it.each([
    '<svg><script>alert(1)</script></svg>',
    '<math><annotation-xml encoding="text/html"><script>alert(1)</script></annotation-xml></math>',
    '<svg><foreignObject><p onclick="x()">f</p></foreignObject></svg>',
    '<svg><animate attributeName="href" values="javascript:alert(1)"/></svg>',
    '<svg><set attributeName="onmouseover" to="alert(1)"/></svg>',
  ])("should leave no executable surface for %s under import", (hostile) => {
    const out = sanitizedToHtml(`<article>${hostile}</article>`, "import");

    expect(out).not.toContain("<script");
    expect(liveEventAttributes(out)).toEqual([]);
    expect(hasExecutableContent(parseHtml(out).root)).toBe(false);
  });

  it("should strip mXSS-shaped markup down to inert content under print", () => {
    // 经典 mglyph/mtext 混合命名空间逃逸形：无论解析器怎么重排，out 里不许出现事件属性。
    const hostile =
      '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=1 onerror=alert(1)>">';
    const out = sanitizedToHtml(`<article>${hostile}</article>`, "print");

    expect(liveEventAttributes(out)).toEqual([]);
  });
});

describe("sanitize 对抗 · 伪协议编码", () => {
  it.each([
    '<a href="&#106;avascript:alert(1)">x</a>',
    '<a href="java&Tab;script:alert(1)">x</a>',
    '<a href="jav&#x09;ascript:alert(1)">x</a>',
    '<a href=" &#14; javascript:alert(1)">x</a>',
    '<a href="javascript&#58;alert(1)">x</a>',
  ])("should strip the entity-obfuscated dangerous href under print: %s", (hostile) => {
    const out = sanitizedToHtml(`<article>${hostile}</article>`, "print");

    expect(out.toLowerCase()).not.toContain("javascript");
  });
});

describe("sanitize 对抗 · style 属性的外链 url() 口径", () => {
  // `STYLE_EXTERNAL_URL` 只认字面 `url(` + 裸 `//`：`url(\68 ttp://…)`（CSS 转义）与
  // `url( ' http://…' )`（引号内空白）都绕过——print 冻结契约 → 记入汇报"需决策"，不在此钉用例。
  it("should still drop the literal external url() shapes under print", () => {
    for (const hostile of [
      '<p style="background:url(http://evil.example/x.png)">x</p>',
      '<p style="background:url(//evil.example/x.png)">x</p>',
      "<p style=\"background:url('https://evil.example/x.png')\">x</p>",
    ]) {
      const out = sanitizedToHtml(`<article>${hostile}</article>`, "print");
      expect(out).not.toContain("evil.example");
    }
  });
});

describe("sanitize 对抗 · 整删名单的完整覆盖", () => {
  it.each([
    '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    '<base href="https://evil.example/">',
    '<meta http-equiv="refresh" content="0; url=javascript:alert(1)">',
    '<object data="javascript:alert(1)"></object>',
    '<embed src="javascript:alert(1)">',
    '<template><script>alert(1)</script></template>',
    '<xmp><img onerror=alert(1)></xmp>',
    '<noembed><img onerror=alert(1)></noembed>',
    '<plaintext><img onerror=alert(1)>',
  ])("should remove the raw-text/embedded payload under import: %s", (hostile) => {
    const out = sanitizedToHtml(`<article>${hostile}</article>`, "import");

    expect(hasExecutableContent(parseHtml(out).root)).toBe(false);
    expect(liveEventAttributes(out)).toEqual([]);
  });
});

describe("sanitize 对抗 · 幂等性", () => {
  const HOSTILES = [
    '<article><noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript><p>ok</p></article>',
    '<article><xmp><script>alert(1)</script></xmp><p style="color:red" onclick="f()">ok</p></article>',
    '<article><svg><script>x</script><foreignObject><p>f</p></foreignObject></svg><a href="javascript:x">l</a></article>',
    '<article><img src="https://cdn.example/x.png"><img src="data:image/png;base64,AA"><template><b>t</b></template></article>',
  ];

  it.each(["print", "import"] as const)(
    "should be idempotent under %s: sanitize(sanitize(x)) === sanitize(x)",
    (preset) => {
      for (const hostile of HOSTILES) {
        const once = sanitizedToHtml(hostile, preset);
        const twice = sanitizedToHtml(once, preset);
        expect(twice).toBe(once);
      }
    },
  );
});

describe("hasExecutableContent · 漏报面", () => {
  it("should report executable for javascript: in form action", () => {
    expect(
      hasExecutableContent(parseHtml('<form action="javascript:alert(1)"><p>x</p></form>').root),
    ).toBe(true);
  });

  it("should report executable for javascript: in button/input formaction", () => {
    expect(
      hasExecutableContent(
        parseHtml('<button formaction="javascript:alert(1)">go</button>').root,
      ),
    ).toBe(true);
    expect(
      hasExecutableContent(
        parseHtml('<input formaction="javascript:alert(1)" value="go">').root,
      ),
    ).toBe(true);
  });

  it("should report executable for an on* attribute with unusual spacing/case", () => {
    expect(
      hasExecutableContent(parseHtml('<p ONCLICK="x()">t</p>').root),
    ).toBe(true);
    expect(
      hasExecutableContent(parseHtml('<img src=x onerror = "alert(1)">').root),
    ).toBe(true);
  });

  it("should stay false for <xmp> text passthrough (inert in browser)", () => {
    expect(
      hasExecutableContent(parseHtml("<xmp><script>alert(1)</script></xmp>").root),
    ).toBe(false);
  });
});
