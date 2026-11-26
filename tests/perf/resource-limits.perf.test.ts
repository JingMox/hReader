// Adversarial surface · measured resource exhaustion. A hostile document's only
// goal is to stall the daemon's event loop — parse, tag-balance regexes (the
// nested-quantifier face), sanitize and serialize must all stay near-linear.
// The pinned bounds are **orders of magnitude**, not precise values: they are
// generous enough that only a real (regex) blowup turns red.
// These are absolute CPU-time budgets, so they live outside the coverage run
// (v8 instrumentation would false-red them) and run under `pnpm test:perf`
// with a single worker (see vitest.perf.config.ts).

import { describe, expect, it } from "vitest";

import {
  hasExecutableContent,
  isDroppedNode,
  parseHtml,
  sanitizedAttributesOf,
  serializeHtml,
  hasExternalResource,
} from "@hreader/core";
import type { HtmlNode } from "@hreader/core";
import { tagBalanceDiagnostics } from "../../packages/core/src/html/balance.ts";

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

describe("resource · parsing and sanitizing stay near-linear", () => {
  it("should parse + balance + sanitize 3k-deep nesting inside a sane budget", () => {
    const html = deepDoc(3000);
    const total = timed(() => {
      const parsed = parseHtml(html);
      tagBalanceDiagnostics(html);
      clean(parsed.root);
      serializeHtml({ root: parsed.root, diagnostics: [] });
    });
    // Near-linear end to end: a quadratic/exponential blowup at 3000 levels
    // would overshoot this by far more than an order of magnitude.
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
    // '"a"'.repeat(n) + '!': alternating quotes are the ambiguity detonator of
    // (?:[^>"']|"[^"]*"|'[^']*')* in TAG_PATTERN. 10k measures sub-millisecond —
    // V8 is linear on this shape; an engine/regex change turns this red first.
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
