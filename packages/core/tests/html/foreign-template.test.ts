// 这层管：HTML 命名空间 `template` 与 foreign content（svg/math）里同名元素的区分——
// parse5 只给 HTML `template` 挂 `content`，按 nodeName 判定会在 svg/math 里读 undefined.childNodes 裸崩。
// 回归面：不崩、子树不丢、真模板语义不变、locations 开/关同表现。

import { describe, expect, it } from "vitest";

import { parseHtml, serializeHtml } from "../../src/index";
import { parseFragment } from "../../src/ops/patch-node";
import type { HtmlElementNode, HtmlNode, SourceSpan } from "../../src/html/constants";

const LOCATIONS = [false, true] as const;

const rootOf = (html: string, locations: boolean): HtmlNode =>
  locations ? parseHtml(html, { locations: true }).root : parseHtml(html).root;

const elementsOf = (node: HtmlNode): HtmlElementNode[] => {
  const nested = "children" in node ? node.children.flatMap(elementsOf) : [];
  return node.kind === "element" ? [node, ...nested] : nested;
};

const byTag = (root: HtmlNode, tag: string): HtmlElementNode[] =>
  elementsOf(root).filter((element) => element.tag === tag);

const spanOf = (element: HtmlElementNode | undefined): SourceSpan | undefined =>
  element !== undefined && "span" in element ? element.span : undefined;

const textOf = (node: HtmlNode): string => {
  if (node.kind === "text") return node.value;
  return "children" in node ? node.children.map(textOf).join("") : "";
};

const DOC = (body: string): string => `<html><head></head><body>${body}</body></html>`;

describe("foreign content 里的 <template> 不得按 HTML template 解引用", () => {
  it.each([
    ["带闭合", "<svg><template>x</template></svg>", "x"],
    ["未闭合", "<svg><template>", ""],
    ["大写标签", "<svg><TEMPLATE>y</TEMPLATE></svg>", "y"],
    ["math 命名空间", "<math><template>z</template></math>", "z"],
    ["子元素", '<svg><template class="k"><text>t</text></template></svg>', "t"],
    ["foreignObject 内嵌", "<svg><foreignObject><template>w</template></foreignObject></svg>", "w"],
  ])("should parse %s without throwing and keep the subtree", (_label, body, expectedText) => {
    for (const locations of LOCATIONS) {
      const tree = rootOf(DOC(body), locations);
      const templates = byTag(tree, "template");

      expect(templates).toHaveLength(1);
      expect(textOf(tree)).toBe(expectedText);
      expect(templates[0]?.children).toHaveLength(expectedText.length === 0 ? 0 : 1);
      // 子树没有被当成 HTML template 的 `content` 吞进不可见区域：序列化后仍在原处。
      // 未闭合 / 大写标签的原文本来就会被解析器补齐与折名，这里断"子树在规范化输出里完整"。
      const normalized = DOC(body)
        .replace("<TEMPLATE>", "<template>")
        .replace("</TEMPLATE>", "</template>");
      const closed =
        expectedText.length === 0 ? DOC("<svg><template></template></svg>") : normalized;
      expect(serializeHtml(parseHtml(DOC(body)))).toBe(closed);
    }
  });
});

describe("foreign content 的子树保真（不崩 ≠ 没丢内容）", () => {
  it("should keep <circle> inside an svg <template> over two round trips", () => {
    const html = DOC('<svg><template><circle cx="1"></circle></template></svg>');
    for (const locations of LOCATIONS) {
      const tree = rootOf(html, locations);
      const circles = byTag(tree, "circle");

      expect(circles).toHaveLength(1);
      expect(circles[0]?.attrs).toEqual([["cx", "1"]]);
      expect(serializeHtml(parseHtml(html))).toBe(html);
      expect(serializeHtml(parseHtml(serializeHtml(parseHtml(html))))).toBe(html);
    }
  });

  it("should keep the single-quoted / self-closing tree even though serialize normalizes quoting", () => {
    const source = DOC("<svg><template><circle cx='1'/></template></svg>");
    const normalized = DOC('<svg><template><circle cx="1"></circle></template></svg>');
    const tree = parseHtml(source).root;
    const circle = byTag(tree, "circle");

    expect(circle).toHaveLength(1);
    expect(circle[0]?.attrs).toEqual([["cx", "1"]]);
    // 序列化器统一双引号 + 展开自闭合（不改树）；把这一点钉住，避免把"规范化"误判成"丢内容"。
    expect(serializeHtml(parseHtml(source))).toBe(normalized);
  });
});

describe("foreign content 的 span 与往返", () => {
  it("should give a foreign <template> a real source span in locations mode", () => {
    const tree = parseHtml("<svg><template>x</template></svg>", { locations: true }).root;
    const template = byTag(tree, "template")[0];

    expect(template?.span).toEqual({ start: 5, end: 27, innerStart: 15, innerEnd: 16 });
    expect(byTag(tree, "svg")[0]?.span).toEqual({ start: 0, end: 33, innerStart: 5, innerEnd: 27 });
  });
});

describe("parseFragment（applyPatch 入口）不再裸崩", () => {
  it("should survive parseFragment instead of crashing with a TypeError", () => {
    for (const html of [
      "<svg><template>x</template></svg>",
      "<math><template>z</template></math>",
      "<svg><TEMPLATE>y</TEMPLATE></svg>",
    ]) {
      const node = parseFragment(html);

      expect(elementsOf(node).some((element) => element.tag === "template")).toBe(true);
    }
  });

  it("should parse the unclosed variant instead of crashing with a TypeError", () => {
    // 片段校验已改成"先解析后校验"：单根片段由 HTML5 容错解析补齐，未闭合不再算非法。
    // 这条用例原本担心的"裸崩"仍要守住：无论如何只能给出树或 HrError，不能是 TypeError。
    let node: unknown;
    try {
      node = parseFragment("<svg><template>");
    } catch (thrown: unknown) {
      const code: unknown = Reflect.get(Object(thrown), "code");
      expect(typeof code).toBe("string");
      return;
    }
    expect(Object(node)).toHaveProperty("kind");
  });
});

describe("真模板（HTML 命名空间）语义不受修复影响", () => {
  it("should keep <template> children inline, in <head>, without a <content> wrapper", () => {
    for (const locations of LOCATIONS) {
      const tree = rootOf(
        "<html><head><template>x</template></head><body></body></html>",
        locations,
      );
      const templates = byTag(tree, "template");

      expect(templates).toHaveLength(1);
      expect(templates[0]?.children).toHaveLength(1);
      expect(templates[0] === undefined ? "" : textOf(templates[0])).toBe("x");
      expect(elementsOf(tree).some((element) => element.tag === "content")).toBe(false);
      expect(spanOf(templates[0])).toEqual(
        locations ? { start: 12, end: 34, innerStart: 22, innerEnd: 23 } : undefined,
      );
    }
  });

  it("should emit the HTML template element without any wrapper element", () => {
    const html = "<html><head><template>x</template></head><body></body></html>";

    expect(serializeHtml(parseHtml(html))).toBe(html);
  });
});
