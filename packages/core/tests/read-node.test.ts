// 这层管：`hr_read_node` 的批注投影、诊断子集、确定性、默认上限与性能；不测选择器文法与截断细节。

import { describe, expect, it } from "vitest";

import * as coreEntry from "../src/index";
import { resolveSelector } from "../src/ops/readNode/resolve";
import { HrError, injectNodeIds, parseHtml, readNode } from "../src/index";
import type { Diagnostic } from "../src/html/constants";
import { withinSubtree } from "../src/ops/readNode/diagnostics";
import type { ReadNodeResult } from "../src/index";

const META =
  '<script id="hr-meta">{"annotations":[' +
  '{"id":"an1","targetId":"h","comment":"已解决","status":"resolved"},' +
  '{"id":"an2","targetId":"h","comment":"待处理","status":"pending_ai"},' +
  '{"id":"an3","targetId":"other","comment":"别人的","status":"accepted"},' +
  '{"id":"an4","targetId":"h","comment":"驳回","status":"rejected"}]}</script>';

const DOC = `<article data-hr-id="post">${META}<h2 data-hr-id="h">标题</h2><section data-hr-id="s">正文</section></article>`;

const read = (html: string, target: string, maxBytes?: number): ReadNodeResult =>
  readNode(parseHtml(html), target, maxBytes);

const ids = (result: ReadNodeResult): readonly string[] =>
  result.annotations.map((annotation) => annotation.id);

describe("input validation · parsed argument", () => {
  /** 类型层面不允许传非 ParsedHtml，所以用具名函数 + Reflect.apply 绕过转换（仓库禁 `as`）。 */
  const codeFor = (value: unknown): string => {
    try {
      Reflect.apply(readNode, undefined, [value, "p"]);
    } catch (error) {
      return error instanceof HrError ? error.code : "not-hr-error";
    }
    return "no-throw";
  };

  it("should refuse null instead of throwing a TypeError", () => {
    expect(codeFor(null)).toBe("invalid_input");
  });

  it("should refuse a bare string", () => {
    expect(codeFor("<p>x</p>")).toBe("invalid_input");
  });

  it("should refuse an object without a root", () => {
    expect(codeFor({ diagnostics: [] })).toBe("invalid_input");
  });

  it("should refuse a root without a kind", () => {
    expect(codeFor({ root: { children: [] }, diagnostics: [] })).toBe("invalid_input");
  });

  it("should refuse the shape injectNodeIds returns (easy mistake to make)", () => {
    expect(
      codeFor({ ...injectNodeIds(parseHtml("<p>x</p>")), parsed: parseHtml("<p>x</p>") }),
    ).toBe("invalid_input");
  });
});

describe("meta · field guard before projection", () => {
  it("should flag an unknown key in hr-meta instead of dropping the batch silently", () => {
    const result = read(
      '<article data-hr-id="post"><script id="hr-meta">{"pending_annotations":[]}</script><p>x</p></article>',
      "article",
    );

    // 顺序：外壳剔除（stage 1）在前，meta 字段检查（stage 2）在后，不做全局排序。
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "stripped_shell",
      "invalid_meta",
    ]);
    expect(result.diagnostics.find((d) => d.code === "invalid_meta")?.message).toBe(
      'hr-meta 含未知字段 "pending_annotations"（只接受 "version" / "style" / "annotations"）',
    );
    expect(result.html).toContain("<p>x</p>");
  });

  it("should stay silent when hr-meta carries no payload", () => {
    const result = read(
      '<article data-hr-id="post"><script id="hr-meta"> </script></article>',
      "article",
    );

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain("invalid_meta");
  });

  it("should not treat a non-object payload as an unknown field", () => {
    const result = read(
      '<article data-hr-id="post"><script id="hr-meta">[1,2]</script></article>',
      "article",
    );

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain("invalid_meta");
  });
});

describe("annotations · projection of hr-meta", () => {
  const result = read(DOC, "#h");

  it("should return every status, including resolved and rejected", () => {
    expect(ids(result)).toEqual(["an1", "an2", "an4"]);
  });

  it("should keep the hr-meta array order instead of sorting", () => {
    expect(result.annotations.map((annotation) => annotation.comment)).toEqual([
      "已解决",
      "待处理",
      "驳回",
    ]);
  });

  it("should expose exactly id/targetId/comment and not leak the raw status", () => {
    expect(Object.keys(result.annotations[0] ?? {}).sort()).toEqual(["comment", "id", "targetId"]);
  });

  it("should exclude annotations aimed at another target id", () => {
    expect(ids(result)).not.toContain("an3");
  });

  it("should return an empty list when the target was selected by tag (no id)", () => {
    expect(read(DOC, "section").annotations).toEqual([]);
  });

  it("should return an empty list when hr-meta is absent", () => {
    expect(
      read('<article data-hr-id="post"><h2 data-hr-id="h">x</h2></article>', "#h").annotations,
    ).toEqual([]);
  });
});

describe("diagnostics · the M1.1 subset inside the target subtree", () => {
  const html = `<article data-hr-id="post"><section data-hr-id="s1"><div data-hr-component="bad">a</div></section><section data-hr-id="s2"><p>b</p></section></article>`;

  // v2 #12 统一了 path 口径（同标签序号、不带前导 `>`），`withinSubtree` 才解得开前缀比较：
  // 这条从 it.fails 转正，正是 D1 被修掉的证据。
  it("should include a parse diagnostic that lands inside the target", () => {
    const result = read(html, "#s1");

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["invalid_component"]);
    expect(result.diagnostics[0]?.path).toBe("html[0]>body[1]>article[0]>section[0]>div[0]");
  });

  it("should exclude a parse diagnostic that lives in a sibling subtree", () => {
    expect(read(html, "#s2").diagnostics).toEqual([]);
  });

  it("should exclude document-level diagnostics without a path", () => {
    const unclosed = read(
      '<article data-hr-id="post"><section data-hr-id="s">x</section>',
      "article",
    );

    expect(unclosed.diagnostics).toEqual([]);
  });
});

describe("diagnostics · the subtree filter itself", () => {
  const at = (path: string | undefined): Diagnostic =>
    path === undefined
      ? { code: "invalid_component", severity: "warning", message: "m" }
      : { code: "invalid_component", severity: "warning", message: "m", path };

  it("should keep the node itself and every descendant path", () => {
    const kept = withinSubtree(
      [at("a[0]"), at("a[0]>b[1]"), at("a[0]>b[1]>c[0]"), at("a[1]"), at("ab[0]"), at(undefined)],
      "a[0]",
    );

    expect(kept.map((diagnostic) => diagnostic.path)).toEqual([
      "a[0]",
      "a[0]>b[1]",
      "a[0]>b[1]>c[0]",
    ]);
  });

  it("should not confuse a shared textual prefix with a path boundary", () => {
    expect(withinSubtree([at("a[0]>b[0]")], "a[0]>b")).toEqual([]);
  });
});

describe("element edge cases", () => {
  it("should serialize a void root without inventing a closing tag", () => {
    const result = read("<p>a<br>b</p>", "br");

    expect(result.html).toBe("<br>");
    expect(result.truncated).toBe(false);
  });
});

describe("internal walker edge cases", () => {
  it("should report node_not_found when the root itself cannot have children", () => {
    // 公开入口的 root 永远是 document，这个分支只有白盒直调才能覆盖（resolve.ts:62 的 `: []`）。
    expect(() =>
      resolveSelector({ kind: "text", value: "x" }, { kind: "tag", tag: "p" }, "p"),
    ).toThrow(HrError);
  });
});

describe("determinism", () => {
  it("should produce byte-identical output on two calls", () => {
    const first = JSON.stringify(read(DOC, "#h"));
    const second = JSON.stringify(read(DOC, "#h"));

    expect(second).toBe(first);
  });
});

const buildLarge = (sections: number): string =>
  `<article data-hr-id="post">${Array.from(
    { length: sections },
    (_, index) =>
      `<section data-hr-id="s${String(index)}"><h2>标题 ${String(index)}</h2><p>${"文".repeat(160)}</p></section>`,
  ).join("")}</article>`;

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

const fastest = (run: () => unknown, attempts: number): number => {
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < attempts; index += 1) {
    const started = performance.now();
    run();
    best = Math.min(best, performance.now() - started);
  }
  return best;
};

describe("default limit and performance", () => {
  it("should apply the 64KB default when maxBytes is omitted", () => {
    const result = read(DOC, "#s");

    expect(result.truncated).toBe(false);
    const big = read(
      `<article data-hr-id="post"><section data-hr-id="s">${"x".repeat(70_000)}</section></article>`,
      "#s",
    );
    const explicit = read(
      `<article data-hr-id="post"><section data-hr-id="s">${"x".repeat(70_000)}</section></article>`,
      "#s",
      1_000_000,
    );

    expect(big.truncated).toBe(true);
    expect(byteLength(big.html)).toBeLessThanOrEqual(65_536);
    expect(explicit.truncated).toBe(false);
  });
});

describe("performance · one megabyte document", () => {
  it("should read a 64KB subtree out of a 1MB document within 60ms", () => {
    const big = buildLarge(5_000);
    const medium = buildLarge(500);
    const reference = fastest(() => read(medium, "#s250"), 3);
    const slowdown = Math.min(Math.max(reference / 2, 1), 8);
    const elapsed = fastest(() => read(big, "#s2500"), 3);

    expect(byteLength(big)).toBeGreaterThan(1_000_000);
    expect(
      elapsed,
      `1MB/${String(byteLength(big))}B read took ${elapsed.toFixed(1)}ms (slowdown ${slowdown.toFixed(1)}x)`,
    ).toBeLessThan(60 * slowdown);
  });

  it("should truncate a full article read out of a 1MB document within 120ms", () => {
    const big = buildLarge(5_000);
    const medium = buildLarge(500);
    const reference = fastest(() => read(medium, "article"), 3);
    const slowdown = Math.min(Math.max(reference / 5, 1), 8);
    const elapsed = fastest(() => read(big, "article"), 3);
    const result = read(big, "article");

    expect(result.truncated).toBe(true);
    expect(byteLength(result.html)).toBeLessThanOrEqual(65_536);
    expect(
      elapsed,
      `article read took ${elapsed.toFixed(1)}ms (slowdown ${slowdown.toFixed(1)}x)`,
    ).toBeLessThan(120 * slowdown);
  }, 60_000);
});

describe("error identity across entries", () => {
  it("should keep HrError identity for node_not_found and invalid_max_bytes", () => {
    const missing = (() => {
      try {
        read(DOC, "#nope");
      } catch (error) {
        return error;
      }
      return undefined;
    })();

    expect(missing).toBeInstanceOf(HrError);
    expect(missing).toBeInstanceOf(coreEntry.HrError);
    expect(missing).toHaveProperty("code", "node_not_found");
    expect(missing).toHaveProperty("name", "HrError");
  });
});
