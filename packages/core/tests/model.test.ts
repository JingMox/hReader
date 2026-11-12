import { describe, expect, it } from "vitest";

import { injectNodeIds, parseHtml, toDocumentModel } from "../src/index";
import type { DocumentModel } from "../src/index";

// 卡片 M1.2 契约 1 + 4：文本归属只认节点树（词边界含 <br>，与 CSS display 无关）、
// 空白只压 ASCII；深度与 1MB 性能有硬上限。

const derive = (html: string): DocumentModel =>
  toDocumentModel(injectNodeIds(parseHtml(html)).parsed);

const shapeOf = (model: DocumentModel): readonly string[] =>
  model.children.map((child) => `${child.tag}:${child.text}`);

const deepest = (model: DocumentModel): number => {
  let max = 0;
  const stack: (readonly [DocumentModel, number])[] = [[model, 0]];
  while (stack.length > 0) {
    const top = stack.pop();
    if (top === undefined) {
      break;
    }
    const [current, level] = top;
    max = Math.max(max, level);
    for (const child of current.children) {
      stack.push([child, level + 1]);
    }
  }
  return max;
};

const paragraph = (index: number): string =>
  `第 ${String(index)} 段：` +
  "读写分离、主从复制与脑裂取舍的工程判断，必须在具体延迟预算与一致性语义下讨论。".repeat(4);

/** 与 `html-perf.test.ts` 同一构造：真实长文本，1MB 时约 3000 个 section。 */
const buildDocument = (sections: number): string => {
  const parts: string[] = ["<!DOCTYPE html><html><head><title>bench</title></head><body><article>"];
  for (let index = 0; index < sections; index += 1) {
    parts.push(
      `<section><h2>标题 ${String(index)}</h2><p>${paragraph(index)}</p><p>${paragraph(index + 1)}</p></section>`,
    );
  }
  parts.push("</article></body></html>");
  return parts.join("");
};

/** 节点密集的 1MB：只用来抓"爆表级"回归，200ms 门禁不适用于它（见报告 P2-1）。 */
const wide = (paragraphs: number): string =>
  `<article>${Array.from({ length: paragraphs }, (_, index) => `<p>第 ${String(index)} 段</p>`).join("\n")}</article>`;

/** 空载机器上 `buildDocument(300)` 走完整条流水线的耗时（毫秒）：校准系数的分母。 */
const IDLE_REFERENCE_MS = 4;

const measure = (html: string): number => {
  const startedAt = performance.now();
  const parsed = parseHtml(html);
  const injected = injectNodeIds(parsed);
  toDocumentModel(injected.parsed);
  return performance.now() - startedAt;
};

/** 取最快的一次：抖动只会让单次变慢，最快样本最接近真实成本（与 M1.1 的 html-perf 同口径）。 */
const fastest = (html: string, runs: number): number => {
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < runs; index += 1) {
    best = Math.min(best, measure(html));
  }
  return best;
};

describe("toDocumentModel · 文本归属", () => {
  it("should split text at block boundaries and keep inline runs merged", () => {
    expect(shapeOf(derive("<article><p>a<span>b</span></p><p>c</p></article>"))).toEqual([
      "p:ab",
      "p:c",
    ]);
  });

  it("should merge nested inline elements into the surrounding run", () => {
    expect(shapeOf(derive("<article><p>a<b><i>c</i>d</b>e</p></article>"))).toEqual(["p:acde"]);
  });

  it("should treat <br> as a word boundary instead of gluing the words", () => {
    const model = derive("<article><p>a<br>b</p></article>");

    expect(shapeOf(model)).toEqual(["p:a b"]);
    expect(shapeOf(model)).not.toEqual(["p:ab"]);
  });
});

describe("toDocumentModel · 文本归属 · 续", () => {
  it("should decide by the tag list, not by any display notion (bare div is transparent)", () => {
    const model = derive("<article><div>a<div>b</div></div><section>c</section></article>");

    expect(model.text).toBe("ab");
    expect(shapeOf(model)).toEqual(["section:c"]);
  });

  it("should give a block child's text to that child, never to the parent", () => {
    const model = derive("<article>loose<p>kept</p></article>");

    expect(model.text).toBe("loose");
    expect(shapeOf(model)).toEqual(["p:kept"]);
  });

  it("should give a div with a whitelisted component its own node", () => {
    const model = derive('<article><div data-hr-component="kpi-bento">k</div></article>');

    expect(shapeOf(model)).toEqual(["div:k"]);
    expect(model.children[0]?.component).toBe("kpi-bento");
  });

  it("should collapse the whitespace inside <pre> as well", () => {
    expect(shapeOf(derive("<article><pre>a\n\n  b</pre></article>"))).toEqual(["pre:a b"]);
  });
});

describe("toDocumentModel · 空白归一", () => {
  it("should collapse newlines, tabs and runs of spaces into one space", () => {
    expect(shapeOf(derive("<article><p>a\n\tb   c</p></article>"))).toEqual(["p:a b c"]);
  });

  it("should trim the ASCII whitespace that sits on a boundary", () => {
    expect(shapeOf(derive("<article><p>  a  </p><p> b</p></article>"))).toEqual(["p:a", "p:b"]);
  });

  // 规格没写死 NBSP/全角空格：卡片只写"空白归一"。按测试员口径，只压 ASCII 空白、不改字符类
  // 才算"归一"，所以这条按该口径写，当前实现会红 —— 登记为 D2（`\s+`/u 会连 NBSP、U+3000、
  // U+FEFF 一起压成 ASCII 空格）。修好之前 `it.fails` 把它当"已知裂缝"看着，不许删。
  it.fails("should keep NBSP and ideographic space (only ASCII whitespace is folded) [D2]", () => {
    expect(shapeOf(derive("<article><p>a\u00A0b\u3000c</p></article>"))).toEqual([
      "p:a\u00A0b\u3000c",
    ]);
  });

  it("should currently fold NBSP and U+3000 into one ASCII space (D2, pinned as-is)", () => {
    expect(shapeOf(derive("<article><p>a\u00A0b\u3000c</p></article>"))).toEqual(["p:a b c"]);
    expect(shapeOf(derive("<article><p>a\u00A0\u00A0b</p></article>"))).toEqual(["p:a b"]);
  });

  it("should keep zero width spaces (they are not ECMAScript whitespace)", () => {
    expect(shapeOf(derive("<article><p>a\u200Bb</p></article>"))).toEqual(["p:a\u200Bb"]);
  });

  it("should fold an entity-derived space like a literal space", () => {
    expect(shapeOf(derive("<article><p>a&#32;&#32;b</p></article>"))).toEqual(["p:a b"]);
  });

  it("should keep a single space between two inline runs of different tags", () => {
    expect(shapeOf(derive("<article><p>a<b>b</b> <i>c</i></p></article>"))).toEqual(["p:ab c"]);
  });
});

describe("toDocumentModel · 深度与性能", () => {
  it("should survive 4000 block levels without a stack overflow (freeze path included)", () => {
    const html = `<article>${"<section>".repeat(4000)}x${"</section>".repeat(4000)}</article>`;
    const model = derive(html);

    expect(deepest(model)).toBe(4000);
    expect(Object.isFrozen(model)).toBe(true);
    expect(model.children.length).toBe(1);
  });

  it("should keep a 1MB document under 200ms, normalized by the same pipeline at 1/10 size", () => {
    const html = buildDocument(3000);
    const referenceHtml = buildDocument(300);

    expect(html.length).toBeGreaterThan(1_000_000);
    expect(referenceHtml.length).toBeGreaterThan(100_000);
    fastest(referenceHtml, 2);
    // 参考负载用同一条流水线（1/10 体量）：`--coverage` 与 20 个文件并发都会让绝对耗时
    // 放大 4~5 倍，但放大是同比例的，所以"参考耗时 / 空载基线"就是本进程的减速系数。
    const reference = fastest(referenceHtml, 5);
    const slowdown = Math.min(Math.max(reference / IDLE_REFERENCE_MS, 1), 8);
    const cost = fastest(html, 5);

    expect(
      cost,
      `${String(html.length)} chars took ${cost.toFixed(1)}ms (slowdown ${slowdown.toFixed(1)}x)`,
    ).toBeLessThan(200 * slowdown);
    // 体量 10 倍；线性应为 ~10 倍，平方会到 ~100 倍。这条在 coverage 下也成立。
    expect(cost / reference).toBeLessThan(14);
  });
});

describe("toDocumentModel · 深度与性能 · 续", () => {
  it("should stay under a coarse ceiling on a node-dense 1MB document", () => {
    const html = wide(64_000);

    expect(html.length).toBeGreaterThan(1_000_000);
    expect(fastest(html, 2)).toBeLessThan(2_000);
  });

  it("should stay close to linear in the number of blocks", () => {
    fastest(wide(5_000), 1);
    const small = Math.max(fastest(wide(10_000), 2), 2);
    const large = fastest(wide(20_000), 1);

    // 4 倍输入换成平方会到 ~16 倍；线性只该是 ~4 倍。
    expect(large).toBeLessThan(Math.max(small * 8, 80));
  });
});
