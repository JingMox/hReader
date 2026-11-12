import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import { injectNodeIds, parseHtml, serializeHtml } from "../src/index";

const BUDGET_MS = 300;
const TIMEOUT_MS = 120_000;

const paragraph = (index: number): string =>
  `第 ${String(index)} 段：` +
  "读写分离、主从复制与脑裂取舍的工程判断，必须在具体延迟预算与一致性语义下讨论。".repeat(4);

const section = (index: number): string =>
  `<section><h2>标题 ${String(index)}</h2><p>${paragraph(index)}</p><p>${paragraph(index + 1)}</p></section>`;

const buildDocument = (sections: number): string => {
  const parts: string[] = ["<!DOCTYPE html><html><head><title>bench</title></head><body><article>"];
  for (let index = 0; index < sections; index += 1) {
    parts.push(section(index));
  }
  parts.push("</article></body></html>");
  return parts.join("");
};

/** parse + inject 的总耗时（毫秒）。 */
const measure = (html: string): number => {
  const start = performance.now();
  injectNodeIds(parseHtml(html));
  return performance.now() - start;
};

const fastest = (html: string, runs: number): number => {
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < runs; index += 1) {
    best = Math.min(best, measure(html));
  }
  return best;
};

describe("性能 · 1MB 文档", () => {
  it(
    "should parse and inject a 1MB document within 300ms",
    () => {
      const html = buildDocument(3000);
      expect(html.length).toBeGreaterThan(1_000_000);

      const warmup = buildDocument(20);
      fastest(warmup, 2);
      const cost = fastest(html, 3);

      expect(html.length, `body size ${String(html.length)}`).toBeGreaterThan(1_000_000);
      expect(
        cost,
        `parse+inject of ${String(html.length)} chars took ${cost.toFixed(1)}ms`,
      ).toBeLessThanOrEqual(BUDGET_MS);
    },
    TIMEOUT_MS,
  );

  it(
    "should scale sub-quadratically when the document grows 4x",
    () => {
      const small = buildDocument(750);
      const large = buildDocument(3000);

      fastest(small, 2);
      const smallCost = Math.max(fastest(small, 3), 2);
      const largeCost = fastest(large, 2);

      // 线性应为 ~4x，平方 ~16x；取 8x 作为分界，给调度抖动留余量。
      expect(largeCost / smallCost).toBeLessThan(8);
    },
    TIMEOUT_MS,
  );
});

describe("性能 · 10k 深嵌套", () => {
  it(
    "should inject and serialize a 10k-deep tree without RangeError",
    () => {
      const depth = 10_000;
      const html = `<article>${"<section>".repeat(depth - 1)}x${"</section>".repeat(depth - 1)}</article>`;

      const injected = injectNodeIds(parseHtml(html));
      const printed = serializeHtml(injected.parsed);

      // M1.2 v2：最外层 article 自身也是注入目标，所以是 depth 条（article + 9999 层 section）。
      expect(injected.injected).toHaveLength(depth);
      expect(printed.length).toBeGreaterThan(html.length);
    },
    TIMEOUT_MS,
  );
});
