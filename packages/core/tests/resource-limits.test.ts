// 对抗面·资源耗尽实测。恶意文档作者唯一的目标是拖死 daemon 的 event loop——
// 解析、tag-balance 正则（nested quantifier 面）、sanitize、serialize 每道都必须近线性。
// 这里钉住的是**数量级**，不是精确值：断言上限给足余量，回归（正则退化）直接红。

import { describe, expect, it } from "vitest";

import {
  hasExecutableContent,
  isDroppedNode,
  parseHtml,
  sanitizedAttributesOf,
  serializeHtml,
  hasExternalResource,
} from "../src/index";
import { tagBalanceDiagnostics } from "../src/html/balance";
import type { HtmlNode } from "../src/index";

/**
 * Milliseconds of CPU time burned by this process (user+system). Unlike wall
 * time it is not inflated by scheduling stalls, so a bound on it holds under
 * CPU contention; the bounds here are orders of magnitude above real cost.
 */
const cpuMs = (): number => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};

/** Times fn in this process's own CPU ms (assertion-only; the bound is an order of magnitude, not a precise value). */
const timed = (fn: () => void): number => {
  const at = cpuMs();
  fn();
  return cpuMs() - at;
};

const deepDoc = (depth: number): string =>
  `<!doctype html><html><body>${"<div>".repeat(depth)}x${"</div>".repeat(depth)}</body></html>`;

const attrDoc = (count: number): string =>
  `<!doctype html><html><body><p ${Array.from({ length: count }, (_, i) => `a${String(i)}="v"`).join(" ")}>x</p></body></html>`;

const wideDoc = (bytes: number): string =>
  `<!doctype html><html><body><p>${"x".repeat(bytes)}</p></body></html>`;

const quoteStormDoc = (count: number): string =>
  `<!doctype html><html><body><a ${'"a"'.repeat(count)}!><a ${'"'.repeat(count)}!></body></html>`;

const clean = (node: HtmlNode): void => {
  if (node.kind === "element") {
    isDroppedNode(node, "print");
    hasExternalResource(node, "print");
    sanitizedAttributesOf(node, "print");
    node.children.forEach(clean);
  } else if (node.kind === "document") {
    node.children.forEach(clean);
  }
};

describe("resource · 解析与清洗保持近线性", () => {
  it("should parse + balance + sanitize 3k-deep nesting inside a sane budget", () => {
    const html = deepDoc(3000);
    const total = timed(() => {
      const parsed = parseHtml(html);
      tagBalanceDiagnostics(html);
      clean(parsed.root);
      serializeHtml({ root: parsed.root, diagnostics: [] });
    });
    // 全链近线性：3000 层若出现平方/指数退化，毫秒数会跳出两位数一个数量级不止。
    expect(total).toBeLessThan(2000);
  });

  it("should parse + sanitize 10k attributes on one element without quadratic blowup", () => {
    const html = attrDoc(10_000);
    const total = timed(() => {
      const parsed = parseHtml(html);
      clean(parsed.root);
    });
    expect(total).toBeLessThan(2000);
  });

  it("should handle a 4 MiB single-line text node", () => {
    const html = wideDoc(4 * 1024 * 1024);
    const total = timed(() => {
      const parsed = parseHtml(html);
      tagBalanceDiagnostics(html);
      clean(parsed.root);
      hasExecutableContent(parsed.root);
      serializeHtml({ root: parsed.root, diagnostics: [] });
    });
    expect(total).toBeLessThan(4000);
  });

  it("should keep tag-balance regexes linear on quote storms (the nested-quantifier face)", () => {
    // '"a"'.repeat(n) + '!'：交替引号串是 TAG_PATTERN 里 (?:[^>"']|"[^"]*"|'[^']*')* 的歧义引爆面。
    // 实测 10k 规模仍亚毫秒——V8 对该形态线性；若未来换引擎/改正则，这条首先红。
    const html = quoteStormDoc(10_000);
    const total = timed(() => tagBalanceDiagnostics(html));
    expect(total).toBeLessThan(1000);
  });

  it("should keep executable-content scan linear on a doc with many candidate nodes", () => {
    const nodes = Array.from(
      { length: 2000 },
      (_, i) => `<div id="n${String(i)}" style="background:url(x${String(i)}.png)">t</div>`,
    ).join("");
    const html = `<!doctype html><html><body>${nodes}</body></html>`;
    const total = timed(() => {
      const parsed = parseHtml(html);
      clean(parsed.root);
      hasExecutableContent(parsed.root);
    });
    expect(total).toBeLessThan(2000);
  });
});
