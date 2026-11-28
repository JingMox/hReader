// 这层管：搜索渲染的对抗面——snippet/title/path 里混 `<img onerror>`、`</mark><script>`、
// `{{x}}`、RTL 控制符，以及越界/负/重叠/反向的高亮偏移。
// 不变量：数据只可能作为文本节点落地（`NodeSpec.text`），绝不会长成元素；
// 偏移先钳制再切 run，不合法的对直接丢弃，整个过程不抛。

import { describe, expect, it } from "vitest";

import { createFakeHost, stateOf, type FakeHost } from "./support/fake-host.ts";
import type { SearchHit, SearchReply } from "../src/guard.ts";
import { mountSearch } from "../src/widgets/search.ts";

const ROOT = "#hr-root";
const INPUT = `${ROOT} #hr-search-input`;
const DOCS_LIST = `${ROOT} #hr-search-docs-list`;
const ANNS_LIST = `${ROOT} #hr-search-anns-list`;

const EVIL = "<img src=x onerror=alert(1)>{{x}}";

const mountWith = (reply: SearchReply): FakeHost => {
  const fake = createFakeHost();
  const widget = mountSearch({
    host: fake.host,
    parent: ROOT,
    fetch: () => Promise.resolve(reply),
    openHit: () => undefined,
    onIntent: () => undefined,
    schedule: (_ms, run) => {
      run();
      return () => undefined;
    },
  });
  widget.update(stateOf({ searchOpen: true }));
  fake.fire(INPUT, "input", { value: "q" });
  return fake;
};

interface SpecNode {
  readonly tag?: string;
  readonly attrs?: Readonly<Record<string, string>>;
  readonly text?: string;
  readonly children?: readonly SpecNode[];
}

const specsOn = (fake: FakeHost, selector: string): readonly SpecNode[] => {
  const call = fake.calls
    .filter((item) => item.op === "children" && item.args[0] === selector)
    .at(-1);
  return call === undefined ? [] : (JSON.parse(call.args[1] ?? "[]") as SpecNode[]);
};

/** 树里的全部文本节点串起来：等于"渲染层真会写进 DOM 的文本"。 */
const textOfTree = (nodes: readonly SpecNode[]): string =>
  nodes.map((node) => `${node.text ?? ""}${textOfTree(node.children ?? [])}`).join("");

const tagsOfTree = (nodes: readonly SpecNode[]): string[] =>
  nodes.flatMap((node) => [node.tag ?? "", ...tagsOfTree(node.children ?? [])]);

const hitOf = (over: Partial<SearchHit> = {}): SearchHit => ({
  path: "doc.html",
  title: "标题",
  kind: "doc",
  score: 1,
  snippet: "一段正文",
  highlights: [],
  ...over,
});

const replyOf = (results: readonly SearchHit[]): SearchReply => ({
  results,
  total: results.length,
  combine: "and",
  truncated: false,
  diagnostics: [],
});

describe("search widget · XSS 对抗", () => {
  it("should render hostile title/snippet/path as plain text, never as elements", async () => {
    const fake = mountWith(
      replyOf([
        hitOf({
          path: `a${EVIL}b.html`,
          title: `题${EVIL}目`,
          snippet: `前文${EVIL}后文`,
          highlights: [[2, EVIL.length + 2]],
        }),
        hitOf({
          kind: "annotation",
          annotationId: "an-1",
          title: "无害",
          snippet: "批注内容</mark><script>alert(2)</script>尾巴",
          highlights: [[4, 10]],
        }),
      ]),
    );
    await Promise.resolve();
    await Promise.resolve();

    const docs = specsOn(fake, DOCS_LIST);
    const anns = specsOn(fake, ANNS_LIST);
    expect(docs).toHaveLength(1);
    expect(anns).toHaveLength(1);
    // 只允许这几个标签：li/p/span/mark——数据里绝不可能长出 img/script。
    for (const tag of [...tagsOfTree(docs), ...tagsOfTree(anns)]) {
      expect(["li", "p", "span", "mark"]).toContain(tag);
    }
    // 原文一字不差地作为文本落地（含标签符号本身）——它是 `text`，不是 `innerHTML`。
    expect(textOfTree(docs)).toContain(`题${EVIL}目`);
    expect(textOfTree(docs)).toContain(`前文${EVIL}后文`);
    expect(textOfTree(anns)).toContain("批注内容</mark><script>alert(2)</script>尾巴");
    // 属性值只允许是渲染层自己生成的常量——数据绝不进 attrs（path/annotationId 同理，只去导航）。
    const attrValues = (nodes: readonly SpecNode[]): string[] =>
      nodes.flatMap((node) => [
        ...Object.values(node.attrs ?? {}),
        ...attrValues(node.children ?? []),
      ]);
    for (const value of [...attrValues(docs), ...attrValues(anns)]) {
      expect(value).toMatch(/^(search__[\w-]+( search__[\w-]+)*|option|[0-9]+)$/u);
    }
  });

  it("should clamp out-of-range/negative offsets and drop reversed, empty or non-finite ones", async () => {
    const fake = mountWith(
      replyOf([
        hitOf({
          snippet: "abcdef",
          highlights: [
            [-5, 2], // 负起点 → 钳到 0
            [3, 99], // 越界终点 → 钳到长度
            [4, 2], // 反向 → 丢
            [1, 1], // 空段 → 丢
            [Number.NaN, 5], // 非数 → 丢
            [1.5, 4.9], // 小数 → 截断后再钳
          ] as readonly [number, number][],
        }),
      ]),
    );
    await Promise.resolve();
    await Promise.resolve();

    const marks = specsOn(fake, DOCS_LIST)
      .flatMap((item) => item.children ?? [])
      .filter((node) => node.tag === "p")
      .flatMap((node) => node.children ?? [])
      .filter((node) => node.tag === "mark")
      .map((node) => node.text);
    // [-5,2]→"ab"；[1.5,4.9]→[1,4] 与上一段重叠，截出 "cd"；[3,99]→[3,6] 截出 "ef"。
    expect(marks).toEqual(["ab", "cd", "ef"]);
    // 全量文本拼接 = 原 snippet（不多不少）。
    expect(textOfTree(specsOn(fake, DOCS_LIST))).toContain("abcdef");
  });

  it("should survive RTL/control characters and an empty snippet without throwing", async () => {
    const fake = mountWith(
      replyOf([
        hitOf({
          title: "rtl⁦abc⁩",
          path: "x.html",
          snippet: "⁦反向⁩文本",
          highlights: [[0, 4]],
        }),
        hitOf({ path: "empty.html", title: "", snippet: "", highlights: [[0, 5]] }),
      ]),
    );
    await Promise.resolve();
    await Promise.resolve();

    const text = textOfTree(specsOn(fake, DOCS_LIST));
    expect(text).toContain("rtl⁦abc⁩");
    expect(text).toContain("⁦反向⁩文本");
    // 空 snippet + 越界对 → 钳完是空调弃，snippet 段渲染为一个空 span（不抛、不拼错）。
    expect(specsOn(fake, DOCS_LIST)).toHaveLength(2);
  });
});
