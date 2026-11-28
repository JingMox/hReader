// Search quality: exact CJK match, prefix, latin fuzzy vs the CJK no-fuzzy gate, title
// outranking body, annotation hits carrying kind+id, and the snippet-offset property —
// snippet.slice(start, end) is always one of the query's terms, case-insensitively.

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { bodyTextOf } from "../../src/annotations/body-text";
import { parseHtml } from "../../src/html/parse";
import { nodePatchDeps } from "../../src/io/node-fs";
import { addSidecarAnnotation } from "../../src/ops/sidecar-ops";
import { searchLibrary, type SearchHit } from "../../src/search";
import { extractDocFields } from "../../src/search/extract";
import { searchTokensOf } from "../../src/search/tokenize";
import { withWorkspace, writeTextAt } from "../io/harness";

const DOC = (title: string, body: string): string =>
  `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><p>${body}</p></body></html>`;

const find = (dir: string, query: string, limit?: number) =>
  searchLibrary(
    { workspace: dir, query, ...(limit === undefined ? {} : { limit }) },
    nodePatchDeps,
  );

const pathsOf = (hits: readonly SearchHit[]): readonly string[] => hits.map((hit) => hit.path);

/** Bounded Levenshtein — the fuzzy contract is `≤ termLength × 0.2`, and 2 covers every term we search. */
const editDistance = (a: string, b: string): number => {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const top = row[j] ?? 0;
      row[j] = Math.min(
        (row[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = top;
    }
  }
  return row[b.length] ?? 0;
};

/** A highlighted slice is the matched document term: it equals a query term, extends one
 *  (prefix match), or sits within the fuzzy distance of one. */
const matchedBy = (slice: string, queryTerms: ReadonlySet<string>): boolean =>
  [...queryTerms].some(
    (term) => slice === term || slice.startsWith(term) || editDistance(slice, term) <= 2,
  );

/** The snippet contract as a property over every returned hit. */
const expectHighlightsIn = (hits: readonly SearchHit[], query: string): void => {
  const queryTerms = new Set(searchTokensOf(query).map((token) => token.text));
  expect(queryTerms.size).toBeGreaterThan(0);
  for (const hit of hits) {
    expect(hit.highlights.length).toBeGreaterThan(0);
    for (const [start, end] of hit.highlights) {
      const slice = hit.snippet.slice(start, end).toLowerCase();
      expect(
        matchedBy(slice, queryTerms),
        `${JSON.stringify(slice)} must be matched by a query term of ${JSON.stringify(query)}`,
      ).toBe(true);
    }
    expect(hit.snippet.length).toBeLessThanOrEqual(200);
    expect(hit.path.startsWith("/")).toBe(false);
  }
};

describe("searchLibrary quality", () => {
  it("finds a doc by an exact Chinese word", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("摩托车维修", "摩托车 发动机 保养 指南"));
      await writeTextAt(join(dir, "b.html"), DOC("烘焙手册", "面包 发酵 温度"));
      const result = await find(dir, "摩托车");
      expect(pathsOf(result.results)).toEqual(["a.html"]);
      expect(result.results[0]?.kind).toBe("doc");
      expect(result.results[0]?.title).toBe("摩托车维修");
      expect(result.results[0]).not.toHaveProperty("annotationId");
      expect(result.diagnostics).toEqual([]);
      expectHighlightsIn(result.results, "摩托车");
    });
  });

  it("matches a latin prefix", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("修复手册", "the motorcycle engine guide"));
      const result = await find(dir, "motorc");
      expect(pathsOf(result.results)).toEqual(["a.html"]);
      expectHighlightsIn(result.results, "motorc");
    });
  });

  it("tolerates a latin typo within 0.2 edit distance", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("修复手册", "the motorcycle engine guide"));
      // "motocycle" is one deletion off "motorcycle" (distance 1 on 9 chars ≈ 0.11).
      const result = await find(dir, "motocycle");
      expect(pathsOf(result.results)).toEqual(["a.html"]);
    });
  });

  it("never applies fuzzy to CJK terms: 摩拖车 must not hit 摩托", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("摩托车维修", "摩托车 发动机 保养 指南"));
      // "摩拖车" is one segment, one edit off the doc term "摩托" — round(3*0.2)=1 means fuzzy
      // would match it; the CJK gate is the only thing keeping this a miss.
      const result = await find(dir, "摩拖车");
      expect(result.results).toEqual([]);
    });
  });

  it("never applies fuzzy to a longer CJK term either: 一氧化碳 must not hit 二氧化碳", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("化学常识", "二氧化碳 灭火器 原理"));
      // Both are single 5-code-point segments one edit apart: len*0.2 gives a fuzzy window of 1,
      // so an ungated fuzzy search would hit — the CJK gate must not.
      const result = await find(dir, "一氧化碳");
      expect(result.results).toEqual([]);
    });
  });

  it("ranks a title hit above a body hit", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "titled.html"), DOC("变速器手册", "齿轮 润滑油"));
      await writeTextAt(join(dir, "body.html"), DOC("保养记录", "变速器 需要 检查"));
      const result = await find(dir, "变速器");
      expect(pathsOf(result.results)).toEqual(["titled.html", "body.html"]);
      expect(result.results[0]?.score ?? 0).toBeGreaterThan(result.results[1]?.score ?? 0);
    });
  });

  it("returns annotation hits with kind annotation and the right id", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("维修记录", "换了机油"));
      const added = await addSidecarAnnotation(
        {
          workspace: dir,
          file: "a.html",
          selector: "body > p:nth-of-type(1)",
          anchor: { exact: "机油", prefix: "", suffix: "", start: 0 },
          note: "下次换成全合成机油",
          author: "user",
        },
        nodePatchDeps,
      );
      const result = await find(dir, "全合成");
      expect(result.results).toHaveLength(1);
      const hit = result.results[0];
      expect(hit?.kind).toBe("annotation");
      expect(hit?.annotationId).toBe(added.annotation.id);
      expect(hit?.path).toBe("a.html");
      expect(hit?.title).toBe("维修记录");
      expectHighlightsIn(result.results, "全合成");
    });
  });

  it("annotation hits never ride a doc title match", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("变速箱", "换了机油"));
      await addSidecarAnnotation(
        {
          workspace: dir,
          file: "a.html",
          selector: "body > p:nth-of-type(1)",
          anchor: { exact: "机油", prefix: "", suffix: "", start: 0 },
          note: "换全合成机油",
          author: "user",
        },
        nodePatchDeps,
      );
      // The query only matches the doc's title field: the annotation entry must stay out
      // (its indexed text is note+exact alone — the doc title is stored, not indexed).
      const result = await find(dir, "变速箱");
      expect(result.results.map((hit) => hit.kind)).toEqual(["doc"]);
    });
  });

  it("indexes h1-h6 headings and snippets from the headings field", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(
        join(dir, "a.html"),
        "<!doctype html><html><head><title>手册</title></head><body><h5>五级稀有词</h5><p>普通正文</p></body></html>",
      );
      await writeTextAt(
        join(dir, "b.html"),
        "<!doctype html><html><head><title>手册</title></head><body><h6>六级稀有词</h6><p>普通正文</p></body></html>",
      );
      // Each term lives only inside its heading — not the title, not the body — so the hit can
      // only come from the headings field, and the snippet must be sourced from it.
      const h5 = await find(dir, "五级稀有词");
      expect(h5.results[0]?.path).toBe("a.html");
      expect(h5.results[0]?.snippet).toContain("五级稀有词");
      const h6 = await find(dir, "六级稀有词");
      expect(h6.results[0]?.path).toBe("b.html");
      expect(h6.results[0]?.snippet).toContain("六级稀有词");
    });
  });

  it("snippets a doc hit from the title field when only the title matched", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("稀有标题词手册", "完全无关的正文内容"));
      const result = await find(dir, "稀有标题词");
      const hit = result.results[0];
      expect(hit?.snippet).toContain("稀有标题词");
    });
  });

  it("keeps every annotation id distinct so two notes on one doc both hit", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("维修记录", "换了机油 还有滤芯"));
      await addSidecarAnnotation(
        {
          workspace: dir,
          file: "a.html",
          selector: "body > p:nth-of-type(1)",
          anchor: { exact: "机油", prefix: "", suffix: "", start: 0 },
          note: "甲批注词",
          author: "user",
        },
        nodePatchDeps,
      );
      await addSidecarAnnotation(
        {
          workspace: dir,
          file: "a.html",
          selector: "body > p:nth-of-type(1)",
          anchor: { exact: "滤芯", prefix: "", suffix: "", start: 0 },
          note: "乙批注词",
          author: "user",
        },
        nodePatchDeps,
      );
      const result = await find(dir, "批注词");
      // Both entries index under unique ids — collapsing them would drop one note.
      expect(result.results).toHaveLength(2);
      expect(result.results.every((hit) => hit.kind === "annotation")).toBe(true);
      expect(new Set(result.results.map((hit) => hit.annotationId)).size).toBe(2);
    });
  });

  it("indexes the annotation text as note+exact joined by a newline", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), DOC("维修记录", "换了机油"));
      await addSidecarAnnotation(
        {
          workspace: dir,
          file: "a.html",
          selector: "body > p:nth-of-type(1)",
          anchor: { exact: "锚点词", prefix: "", suffix: "", start: 0 },
          note: "",
          author: "user",
        },
        nodePatchDeps,
      );
      const exactOnly = await find(dir, "锚点词");
      // note "" is filtered out — the indexed (and snippet) text is the exact anchor alone.
      expect(exactOnly.results[0]?.snippet).toBe("锚点词");

      // A doc edit re-lists its sidecar annotations — the second note joins the index.
      await writeTextAt(join(dir, "a.html"), DOC("维修记录", "换了机油 明天复查"));
      await addSidecarAnnotation(
        {
          workspace: dir,
          file: "a.html",
          selector: "body > p:nth-of-type(1)",
          anchor: { exact: "机油", prefix: "", suffix: "", start: 0 },
          note: "复合批注",
          author: "user",
        },
        nodePatchDeps,
      );
      const joined = await find(dir, "复合批注");
      expect(joined.results[0]?.snippet).toBe("复合批注\n机油");
    });
  });
});

describe("search text separates element boundaries", () => {
  const PAGE = (title: string, inner: string): string =>
    `<!doctype html><html><head><title>${title}</title></head><body>${inner}</body></html>`;

  it("finds table-cell terms the glued join hid: SSD1306 and M3", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(
        join(dir, "parts.html"),
        PAGE("零件表", "<table><tr><td>module</td><td>1</td><td>SSD1306</td></tr></table>"),
      );
      await writeTextAt(
        join(dir, "screws.html"),
        PAGE("螺丝表", "<table><tr><td>screw</td><td>M3</td><td>steel</td></tr></table>"),
      );
      const ssd = await find(dir, "SSD1306");
      expect(pathsOf(ssd.results)).toEqual(["parts.html"]);
      expectHighlightsIn(ssd.results, "SSD1306");
      expect(pathsOf((await find(dir, "M3")).results)).toEqual(["screws.html"]);
    });
  });

  it("keeps inline boundaries unglued: <b>foo</b>bar indexes foo and bar, never foobar", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "a.html"), PAGE("内联", "<p><b>foo</b>bar</p>"));
      const bar = await find(dir, "bar");
      expect(pathsOf(bar.results)).toEqual(["a.html"]);
      expectHighlightsIn(bar.results, "bar");
      // The glued token must not exist either way: querying it finds nothing.
      expect((await find(dir, "foobar")).results).toEqual([]);
    });
  });

  it("splits at <br> and across list items", async () => {
    await withWorkspace(async (dir) => {
      await writeTextAt(join(dir, "br.html"), PAGE("换行", "<p>alpha<br>beta</p>"));
      await writeTextAt(
        join(dir, "list.html"),
        PAGE("列表", "<ul><li>alpha</li><li>beta</li></ul>"),
      );
      expect(pathsOf((await find(dir, "beta")).results)).toEqual(
        expect.arrayContaining(["br.html", "list.html"]),
      );
      const hits = await find(dir, "beta");
      expect(hits.results).toHaveLength(2);
    });
  });

  it("drops nothing the anchor domain had: every anchor token survives whole or by leading chunk", () => {
    // The anchor model (bodyTextOf) can glue tokens the search model splits apart. Recall
    // safety only needs the token's leading chunk to survive — the segmented half of a
    // glued pair is the search term itself.
    for (const inner of [
      "<table><tr><td>module</td><td>1</td><td>SSD1306</td></tr></table>",
      "<p><b>foo</b>bar</p>",
      "<p>alpha<br>beta</p>",
      "<ul><li>先把它</li><li>module</li><li>2</li></ul>",
      "<p>摩托车<span>维修</span>手册</p><h2>title<b>bold</b></h2>",
    ]) {
      const html = PAGE("t", inner);
      const anchor = searchTokensOf(bodyTextOf(parseHtml(html))).map((token) => token.text);
      const search = new Set(
        searchTokensOf(extractDocFields(html).body).map((token) => token.text),
      );
      for (const term of anchor) {
        expect(
          search.has(term) || [...search].some((token) => term.startsWith(token)),
          `anchor token ${JSON.stringify(term)} vanished from the search text of ${JSON.stringify(inner)}`,
        ).toBe(true);
      }
    }
  });
});
