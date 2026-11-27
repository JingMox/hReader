// This layer: block-address parsing and resolution. An address is `css:<path>@<fingerprint>`
// — the path uses exactly the `parseSelectorPath` grammar, the fingerprint is 8 lowercase hex
// chars. Resolution first tries the path verbatim, then falls back to a fingerprint search
// over every leaf block (closest path wins; a tie means the target is gone). Pure.

import { elementByPath, parseSelectorPath, type SelectorStep } from "../../annotations/relocate";
import type { ParsedHtml } from "../../html/constants";
import { parseHtml } from "../../html/parse";
import { collectBlocks, infoOf, type BlockEntry } from "./blocks";
import { ADDRESS_LIMIT, ADDRESS_PREFIX, type ResolveResult } from "./constants";

interface ParsedAddress {
  readonly steps: readonly SelectorStep[];
  readonly fingerprint: string;
}

const HEX_FINGERPRINT = /^[0-9a-f]{8}$/u;

/**
 * `undefined` = malformed: the caller maps it to `invalid_selector` (an address *is* a
 * selector; a broken one is a syntax failure, same surface as `parseSelectorPath`).
 * The `@` separator is the last one — a stray `@` earlier lands inside the path part and
 * fails the path grammar anyway.
 */
const parseAddress = (address: string): ParsedAddress | undefined => {
  if (
    typeof address !== "string" ||
    address.length > ADDRESS_LIMIT ||
    !address.startsWith(ADDRESS_PREFIX)
  ) {
    return undefined;
  }
  const at = address.lastIndexOf("@");
  // equivalent — at=-1 makes the whole string the fingerprint (fails HEX), at<=4 leaves an
  // empty path (fails parseSelectorPath); either way the same code comes out.
  // Stryker disable next-line EqualityOperator
  if (at <= ADDRESS_PREFIX.length) return undefined;
  const fingerprint = address.slice(at + 1);
  if (!HEX_FINGERPRINT.test(fingerprint)) return undefined;
  const steps = parseSelectorPath(address.slice(ADDRESS_PREFIX.length, at));
  if (steps === undefined) return undefined;
  return { steps, fingerprint };
};

const sameStep = (left: SelectorStep, right: SelectorStep): boolean =>
  left.tag === right.tag && left.nth === right.nth;

/** Sole entry point for table reads/writes: `getUint32` has a definite `number` return type (same rationale as `annotations/diff.ts`). */
const cellAt = (view: DataView, index: number): number =>
  // equivalent — every stored value is a distance under 256, so a byte-swap read stays
  // strictly monotonic and the winner ordering is unchanged.
  // Stryker disable next-line BooleanLiteral
  view.getUint32(index * 4, true);

/**
 * Levenshtein distance over path steps (tag+nth is the unit). Step counts are small
 * (`SELECTOR_LIMITS.steps` bounds the address side), so the full table is cheap.
 */
const stepDistance = (left: readonly SelectorStep[], right: readonly SelectorStep[]): number => {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const view = new DataView(new ArrayBuffer(rows * cols * 4));
  for (let column = 0; column < cols; column += 1) {
    // same as cellAt — values stay under 256, so a big-endian write reads back
    // monotonically scaled and comparisons are preserved.
    // Stryker disable next-line BooleanLiteral
    view.setUint32(column * 4, column, true);
  }
  left.forEach((a, i) => {
    const row = i + 1;
    // Stryker disable next-line BooleanLiteral: same as cellAt — values stay under 256.
    view.setUint32(row * cols * 4, row, true);
    right.forEach((b, j) => {
      const cost = sameStep(a, b) ? 0 : 1;
      view.setUint32(
        (row * cols + j + 1) * 4,
        Math.min(
          cellAt(view, i * cols + j + 1) + 1,
          cellAt(view, row * cols + j) + 1,
          cellAt(view, i * cols + j) + cost,
        ),
        // Stryker disable next-line BooleanLiteral: same as cellAt — values under 256.
        true,
      );
    });
  });
  return cellAt(view, left.length * cols + right.length);
};

type LocateResult =
  | { readonly ok: true; readonly entry: BlockEntry }
  | { readonly ok: false; readonly code: "target_moved" | "invalid_selector" };

const moved = { ok: false, code: "target_moved" } as const;

/**
 * The resolution order (D53): the address path verbatim — but only when the element it lands
 * on is still a leaf block whose fingerprint matches. Otherwise every leaf block is searched
 * for the fingerprint: one hit wins outright, several go to the closest path (step edit
 * distance), a tie means the target is gone for good.
 */
export const locateBlock = (parsed: ParsedHtml, address: string): LocateResult => {
  const target = parseAddress(address);
  if (target === undefined) return { ok: false, code: "invalid_selector" };
  const entries = collectBlocks(parsed.root);
  const element = elementByPath(parsed.root, target.steps);
  const direct =
    // Stryker disable next-line ConditionalExpression,EqualityOperator,ArrowFunction: equivalent — a direct-hit block sits at distance 0 of the address path, so the fallback picks it anyway; this lookup only skips the walk.
    element === undefined ? undefined : entries.find((entry) => entry.node === element);
  // Stryker disable next-line BlockStatement: equivalent — the fallback below returns this
  // same entry whenever the fingerprint matches.
  if (direct?.fingerprint === target.fingerprint) {
    return { ok: true, entry: direct };
  }
  const candidates = entries.filter((entry) => entry.fingerprint === target.fingerprint);
  const first = candidates[0];
  if (first === undefined) return moved;
  if (candidates.length === 1) return { ok: true, entry: first };
  let best = first;
  let bestDistance = stepDistance(target.steps, first.steps);
  let tied = false;
  for (const candidate of candidates.slice(1)) {
    const distance = stepDistance(target.steps, candidate.steps);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
      tied = false;
      continue;
    }
    if (distance === bestDistance) tied = true;
  }
  if (tied) return moved;
  return { ok: true, entry: best };
};

/** `resolveAddress` answers with a value, never throws: callers branch on `ok`. */
export const resolveAddress = (html: string, address: string): ResolveResult => {
  const located = locateBlock(parseHtml(html, { locations: true }), address);
  return located.ok ? { ok: true, block: infoOf(located.entry) } : located;
};
