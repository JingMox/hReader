import { describe, expect, it } from "vitest";

import { injectNodeIds, parseHtml } from "../src/index";
import type { InjectedNodeIds, ParsedHtml } from "../src/index";
import {
  attributeValue,
  childrenOf,
  codesOf,
  collectElements,
  findElement,
  requireElement,
} from "./html-support";

const HR_ID = "data-hr-id";

const inject = (html: string): InjectedNodeIds => injectNodeIds(parseHtml(html));

const idOf = (injected: InjectedNodeIds, tag: string): string | undefined => {
  const element = findElement(injected.parsed.root, tag);
  return element === undefined ? undefined : attributeValue(element, HR_ID);
};

describe("injectNodeIds · 种子采样契约", () => {
  const idFor = (html: string): string | undefined => idOf(inject(html), "p");

  it("should normalise whitespace before hashing", () => {
    expect(idFor("<article><p>a  b\n\tc</p></article>")).toBe(
      idFor("<article><p>a b c</p></article>"),
    );
  });

  it("should take only the first 64 characters of text", () => {
    const prefix = "x".repeat(64);

    expect(idFor(`<article><p>${prefix}A</p></article>`)).toBe(
      idFor(`<article><p>${prefix}B</p></article>`),
    );
    expect(idFor(`<article><p>${"x".repeat(63)}A</p></article>`)).not.toBe(
      idFor(`<article><p>${"x".repeat(63)}B</p></article>`),
    );
  });

  it("should ignore comment siblings and keep text after them", () => {
    expect(idFor("<article><p>a<!--c-->b</p></article>")).toBe(
      idFor("<article><p>ab</p></article>"),
    );
  });
});

describe("injectNodeIds · 纯函数性与手搓树", () => {
  it("should not mutate the input tree and should return a new one", () => {
    const parsed = parseHtml("<article><p>a</p></article>");
    const before = JSON.stringify(parsed);
    const injected = injectNodeIds(parsed);

    expect(JSON.stringify(parsed)).toBe(before);
    expect(injected.parsed).not.toBe(parsed);
  });
});

describe("injectNodeIds · 手搓树", () => {
  it("should walk hand-built document children of every kind", () => {
    const root: ParsedHtml["root"] = {
      kind: "document",
      children: [
        { kind: "doctype", name: "html", publicId: "", systemId: "" },
        { kind: "comment", data: "c" },
        { kind: "text", value: "t" },
        {
          kind: "element",
          tag: "article",
          attrs: [],
          children: [{ kind: "element", tag: "p", attrs: [], children: [] }],
        },
      ],
    };

    const injected = injectNodeIds({ root, diagnostics: [] });

    // article 自身 + 其中的 p；文本/注释/doctype 不是注入目标。
    expect(injected.injected).toHaveLength(2);
    expect(childrenOf(injected.parsed.root).map((node) => node.kind)).toEqual([
      "doctype",
      "comment",
      "text",
      "element",
    ]);
    expect(codesOf(injected.parsed)).toEqual([]);
  });

  it("should accept a non-document root without injecting outside article", () => {
    const parsed: ParsedHtml = { root: { kind: "text", value: "t" }, diagnostics: [] };

    expect(injectNodeIds(parsed).parsed.root).toEqual({ kind: "text", value: "t" });
  });
});

describe("injectNodeIds · 权重规则", () => {
  it("should ignore text, comments and semantic attribute noise", () => {
    // 规则只看 tag + id + class + 元素自身的 data-*；aria-*/dir/title/id 与文本不产生权重。
    const stripped = inject(
      '<article class="note"><h1>a</h1><h2>b</h2><p>x<strong>1</strong><strong>2</strong></p><img><li>i</li><li>j</li></article>',
    );
    const noisy = inject(
      '<article class="note"><h1 aria-hidden="true">a</h1><h2 dir="rtl">b</h2><p aria-label="q">x<strong title="k">1</strong><strong id="s">2</strong></p><img data-a="b"><li>i</li><li dir="rtl">j</li></article>',
    );
    const idsOf = (seeded: InjectedNodeIds): readonly string[] =>
      collectElements(seeded.parsed.root).flatMap((element) => {
        const value = attributeValue(element, "data-hr-id");
        return value === undefined ? [] : [value];
      });

    // 只看 article 子树：文档骨架 html/head/body 是 parse5 补的，不是本用例的被测对象。
    const articleOf = (seeded: InjectedNodeIds): ParsedHtml["root"] =>
      requireElement(seeded.parsed.root, "article");

    expect(collectElements(articleOf(stripped))).toHaveLength(9);
    expect(collectElements(articleOf(noisy))).toHaveLength(9);
    expect(idsOf(stripped)).toHaveLength(6);
    expect(new Set(idsOf(noisy))).toEqual(new Set(idsOf(stripped)));
  });
});
