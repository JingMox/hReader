// This layer: two "shape invariants" of error folding — the folded **cause chain** (downstream walks it back to the errno) and
// `elidedOf`'s **order-independence** over roots (`[cwd, real]` and `[real, cwd]` must fold to the same text).
//
// What makes it red:
// - folding keeps message but drops cause (`foldedOf` loses `cause: error`) → `cause` is no longer the original HrError;
// - folding flattens cause into a string → the original cause's `code` / deeper causes become unreachable;
// - `elidedOf`'s "fold the longer root first" sort gets deleted → the two orders fold differently (macOS `/var` ↔ `/private/var`).

import { describe, expect, it } from "vitest";

import { HrError } from "@hreader/core";

import { elidedOf, foldedOf, rootsOf } from "../src/errors";

const errnoOf = (root: string): Error & { code: string } =>
  Object.assign(new Error(`ENOENT: no such file or directory, open '${root}/doc.html'`), {
    code: "ENOENT",
  });

/** Assert `unknown` really is an HrError and narrow it: stricter than `as` (a wrong type throws on the spot instead of fooling the type check). */
const hrErrorOf = (value: unknown): HrError => {
  if (!(value instanceof HrError)) throw new Error(`not an HrError: ${typeof value}`);
  return value;
};

/**
 * Collect every node along the `cause` chain (with cycle protection). **Only answers "still reachable?"**, does not pin the depth:
 * if `foldedOf` someday attaches the underlying cause directly (better observable behavior, fewer layers), this stays green.
 */
const causesOf = (root: unknown): readonly unknown[] => {
  const chain: unknown[] = [];
  let node: unknown = root instanceof Error ? root.cause : undefined;
  while (node !== undefined && !chain.includes(node)) {
    chain.push(node);
    node = node instanceof Error ? node.cause : undefined;
  }
  return chain;
};

const codeOfCause = (node: unknown): unknown =>
  node instanceof Error && "code" in node ? node.code : undefined;

describe("the folded cause chain", () => {
  it("should keep both the original HrError and its errno reachable along the cause chain", () => {
    const errno = errnoOf("/ws/project");
    const original = new HrError("not_found", "/ws/project/doc.html 不存在", { cause: errno });

    const folded = foldedOf(original);
    expect(folded).toBeInstanceOf(HrError);
    expect(folded).not.toBe(original);
    expect(hrErrorOf(folded).code).toBe("not_found");

    // Downstream reading `cause.code` for the errno is a common pattern: after folding, both must remain reachable on the chain.
    // Not asserting "exactly two layers" — that is internal structure, not contract.
    const chain = causesOf(folded);
    expect(chain).toContain(original);
    expect(chain.map(codeOfCause)).toContain("ENOENT");
  });

  it("should leave a non-HrError untouched so its own errno stays reachable", () => {
    const errno = errnoOf("/ws/project");

    expect(foldedOf(errno)).toBe(errno);
    expect(errno.code).toBe("ENOENT");
  });
});

describe("elidedOf is independent of root order", () => {
  it("should fold the same text whichever order the two roots are given in", () => {
    const cwd = "/var/folders/x/hreader-ws";
    const real = "/private/var/folders/x/hreader-ws";
    const message = `ENOENT: open '${real}/doc.html' while cwd was '${cwd}'`;

    const cwdFirst = elidedOf(
      message,
      rootsOf(cwd, () => real),
    );
    const realFirst = elidedOf(message, [real, cwd]);

    expect(cwdFirst).toBe(realFirst);
    // What folds is the "narrower" root: folding the short root `cwd` inside it would leave malformed text like `/privatedoc.html`.
    // (`elidedOf` is a single-pass replacement and only folds the longest hit; a second occurrence left over is not a defect.)
    expect(cwdFirst).not.toContain("/private");
  });

  it("should fold the same way when the two roots are passed in reverse creation order", () => {
    const cwd = "/var/folders/x/hreader-ws";
    const real = "/private/var/folders/x/hreader-ws";
    const message = `ENOENT: open '${cwd}/doc.html', realpath '${real}/doc.html'`;

    expect(elidedOf(message, [cwd, real])).toBe(elidedOf(message, [real, cwd]));
  });
});
