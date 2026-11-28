// This layer covers the search renderer's adversarial surface: `<img onerror>`,
// `</mark><script>`, `{{x}}`, and RTL control chars inside snippet/title/path, plus
// out-of-range/negative/overlapping/reversed highlight offsets.
// Invariant: data can only land as text nodes (`NodeSpec.text`), never grow elements;
// offsets are clamped before runs are cut, invalid pairs are dropped, and nothing throws.

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

/** All text nodes in the tree joined: equals the text the renderer would actually write into the DOM. */
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

describe("search widget · XSS adversarial cases", () => {
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
    // Only these tags are allowed: li/p/span/mark — data can never grow img/script.
    for (const tag of [...tagsOfTree(docs), ...tagsOfTree(anns)]) {
      expect(["li", "p", "span", "mark"]).toContain(tag);
    }
    // The source lands verbatim as text (tag characters included) — it is `text`, not `innerHTML`.
    expect(textOfTree(docs)).toContain(`题${EVIL}目`);
    expect(textOfTree(docs)).toContain(`前文${EVIL}后文`);
    expect(textOfTree(anns)).toContain("批注内容</mark><script>alert(2)</script>尾巴");
    // Attribute values may only be renderer-generated constants — data never enters attrs (path/annotationId likewise; they only feed navigation).
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
            [-5, 2], // negative start → clamp to 0
            [3, 99], // out-of-range end → clamp to length
            [4, 2], // reversed → drop
            [1, 1], // empty span → drop
            [Number.NaN, 5], // NaN → drop
            [1.5, 4.9], // fractional → truncate, then clamp
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
    // [-5,2]→"ab"; [1.5,4.9]→[1,4] overlaps the previous run, cutting "cd"; [3,99]→[3,6] cuts "ef".
    expect(marks).toEqual(["ab", "cd", "ef"]);
    // The full text concatenation = the original snippet (no more, no less).
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
    // Empty snippet + out-of-range pair → clamps to empty and drops; the snippet run renders as one empty span (no throw, no misassembly).
    expect(specsOn(fake, DOCS_LIST)).toHaveLength(2);
  });
});
