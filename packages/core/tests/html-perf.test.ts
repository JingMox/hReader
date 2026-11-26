import { describe, expect, it } from "vitest";

import { injectNodeIds, parseHtml, serializeHtml } from "../src/index";

const TIMEOUT_MS = 120_000;

/**
 * Milliseconds of CPU time burned by this process (user+system). Unlike wall
 * time it is not inflated by scheduling stalls, so a bound on it holds under
 * CPU contention; same-machine slowness (coverage instrumentation, weak
 * cores) is absorbed by the same-pipeline reference below.
 */
const cpuMs = (): number => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};

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

/** parse + inject cost in milliseconds of this process's own CPU time. */
const measure = (html: string): number => {
  const start = cpuMs();
  injectNodeIds(parseHtml(html));
  return cpuMs() - start;
};

const fastest = (html: string, runs: number): number => {
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < runs; index += 1) {
    best = Math.min(best, measure(html));
  }
  return best;
};

// The absolute 300ms gate of this scenario moved to tests/perf/html.perf.test.ts:
// v8 coverage instrumentation slows `src/**` as a whole (~4x measured), so a
// bare absolute bound false-reds here. The large/small ratio below is
// instrumentation-invariant and stays — a real O(n^2) regression trips both.
/** Interleaved sampling: adjacent windows measure each size once and divide, so both ends share the same machine conditions; returns the minimum ratio over 5 windows. */
const growthRatio = (small: string, large: string): number => {
  fastest(small, 2);
  fastest(large, 2);
  let ratio = Number.POSITIVE_INFINITY;
  for (let window = 0; window < 5; window += 1) {
    const smallCost = Math.max(fastest(small, 1), 0.5);
    ratio = Math.min(ratio, fastest(large, 1) / smallCost);
  }
  return ratio;
};

describe("性能 · 1MB 文档", () => {
  it(
    "should scale sub-quadratically when the document grows 4x",
    () => {
      // 线性应为 ~4x，平方 ~16x；取 8x 作分界（非交错时全量并发下实测 9.0，假红）。
      const ratio = growthRatio(buildDocument(750), buildDocument(3000));

      expect(ratio, `best large/small ratio ${ratio.toFixed(2)}`).toBeLessThan(8);
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

      // 最外层 article 自身也是注入目标，所以是 depth 条（article + 9999 层 section）。
      expect(injected.injected).toHaveLength(depth);
      expect(printed.length).toBeGreaterThan(html.length);
    },
    TIMEOUT_MS,
  );
});
