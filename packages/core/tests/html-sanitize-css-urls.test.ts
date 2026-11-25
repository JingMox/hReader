// 对抗面：print 预设 style 属性的外链 CSS 逃逸面。
// 姊妹用例钉住了 `url(...)` 族（含 CSS 转义解码）；本文件打**不带 url( 的取图函数**——
// `image-set("https://…")`、`-webkit-image-set()`、`image("…")`、`cross-fade("…","…")`、`src("…")`
// 按 CSS Images 语法都接受裸字符串 URL，Chrome 对 image-set 的裸串写法历史支持，
// 而 print 导出稿会进 Chrome 渲染（pdf/png）——漏放就是内网/本机文件 SSRF。

import { describe, expect, it } from "vitest";

import { parseHtml, sanitizedAttributesOf } from "../src/index";
import type { HtmlElementNode, HtmlNode } from "../src/index";

const childrenOf = (node: HtmlNode): readonly HtmlNode[] =>
  node.kind === "element" || node.kind === "document" ? node.children : [];

const elementsOf = (html: string): HtmlElementNode[] => {
  const found: HtmlElementNode[] = [];
  const stack: HtmlNode[] = [parseHtml(html).root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    if (node.kind === "element") found.push(node);
    stack.push(...childrenOf(node));
  }
  return found;
};

const styleAttrOf = (html: string): string | undefined =>
  elementsOf(html)
    .flatMap((node) => node.attrs)
    .find(([name]) => name.toLowerCase() === "style")?.[1];

/** print 预设剥完 style 还在不在：留了值 = 外链串混进了导出稿。 */
const keptStyleOf = (html: string): string | undefined =>
  elementsOf(html)
    .flatMap((node) => sanitizedAttributesOf(node, "print"))
    .find(([name]) => name === "style")?.[1];

describe("print style 里的裸串取图函数", () => {
  it.each([
    'background:image-set("https://intranet.example/x.png" 1x)',
    'background:-webkit-image-set("https://intranet.example/x.png" 1x)',
    'background:-moz-image-set("https://intranet.example/x.png" 1x)',
    "background:image-set('//intranet.example/x.png' 1x)",
    'background:image-set( "http://169.254.169.254/latest/meta-data" 1x)',
    'list-style-image:image-set("https://intranet.example/m.png" 1x)',
    'content:image-set("https://intranet.example/x.png" 1x)',
    'background:cross-fade("https://intranet.example/a.png","https://intranet.example/b.png")',
    'background:image("https://intranet.example/x.png")',
    'background:src("https://intranet.example/x.png")',
    'background:im\\61 ge-set("https://intranet.example/x.png" 1x)',
  ])("裸串外链一律剥 style：%s", (style) => {
    const html = `<p style="${style.replaceAll('"', "&quot;")}">x</p>`;
    expect(keptStyleOf(html)).toBeUndefined();
  });

  it.each([
    "background:image-set(url(https://intranet.example/x.png) 1x)",
    "background:-webkit-image-set(url(//intranet.example/x.png) 1x)",
  ])("函数里再套 url( 也一并剥：%s", (style) => {
    const html = `<p style="${style.replaceAll('"', "&quot;")}">x</p>`;
    expect(keptStyleOf(html)).toBeUndefined();
  });

  it.each(["background:image-set('x.png' 1x, 'y.png' 2x)", "background:url(x.png)", "color:red"])(
    "相对路径与纯属性不误伤：%s",
    (style) => {
      const html = `<p style="${style.replaceAll('"', "&quot;")}">x</p>`;
      expect(keptStyleOf(html)).toBe(style);
    },
  );
});

describe("url() 取图函数防线钉住", () => {
  it.each([
    "background:url(https://intranet.example/x.png)",
    "background: url( ' //intranet.example/x.png' )",
    "background:u\\72 l(//intranet.example/x.png)",
    "background:URL(HTTPS://INTRANET.EXAMPLE/x.png)",
    "background:url(https://evil:80@127.0.0.1/x.png)",
  ])("url() 外链仍被剥：%s", (style) => {
    const html = `<p style="${style.replaceAll('"', "&quot;")}">x</p>`;
    expect(keptStyleOf(html)).toBeUndefined();
    // 确认输入真的带 style（别把"剥光"误判成"没写过"）。
    expect(styleAttrOf(html)).toBeDefined();
  });
});
