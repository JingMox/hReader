// This layer: the block-address vocabulary (block tag set, address bounds, bare data types);
// no parsing, no traversal, no IO.

import { SELECTOR_LIMITS } from "../../annotations/relocate";
import type { PatchOutcome } from "../patch-node";

/**
 * The tags an address may point at. Only *leaf* members are addressable: an element whose
 * subtree contains another block-set element is a container, not a block — patching a container
 * would silently rewrite every block nested inside it.
 */
export const BLOCK_ADDRESS_TAGS: ReadonlySet<string> = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "table",
  "figure",
  "section",
  "article",
  "blockquote",
  "pre",
  "div",
  "ul",
  "ol",
  "dl",
  "dt",
  "dd",
  "header",
  "footer",
  "aside",
  "nav",
  "main",
  "figcaption",
  "details",
  "summary",
]);

export const ADDRESS_PREFIX = "css:";

/** The fingerprint is the first hex characters of sha1 over the block's normalized text. */
export const FINGERPRINT_CHARS = 8;

/** `css:` + selector path (bounded by `SELECTOR_LIMITS.chars`) + `@` + 8 hex chars. */
export const ADDRESS_LIMIT = ADDRESS_PREFIX.length + SELECTOR_LIMITS.chars + 1 + FINGERPRINT_CHARS;

/** `textPreview` is for picking a block out of `listBlocks`, not for hashing. */
export const PREVIEW_CHARS = 80;

/**
 * Unlike `PatchAction` (`insert_before`/`insert_after`), block actions are camelCase:
 * the address surface is a separate contract and follows the design doc's spelling.
 * `append` does not exist here: a leaf block has no block children, so "inside it"
 * can only mean inline content — replacing it covers that need.
 */
export type BlockAction = "replace" | "delete" | "insertBefore" | "insertAfter";

export const BLOCK_ACTIONS: readonly BlockAction[] = [
  "replace",
  "delete",
  "insertBefore",
  "insertAfter",
];

export interface BlockInfo {
  readonly address: string;
  readonly tag: string;
  readonly textPreview: string;
  /** OuterHTML source offsets (the same domain `SourceSpan.start`/`end` use). */
  readonly start: number;
  readonly end: number;
}

export type ResolveResult =
  | { readonly ok: true; readonly block: BlockInfo }
  | { readonly ok: false; readonly code: "target_moved" | "invalid_selector" };

export interface BlockPatchRequest {
  readonly address: string;
  readonly action: BlockAction;
  /** Required for `replace`/`insertBefore`/`insertAfter`; must be absent for `delete`. */
  readonly html?: string;
}

export interface BlockPatchOutcome extends PatchOutcome {
  /**
   * The canonical address of the first leaf block inside the written range — for `replace` the
   * replacement, for `insertBefore`/`insertAfter` the inserted block. `undefined` after `delete`
   * or when the written fragment contains no addressable block (e.g. a bare `<span>`).
   */
  readonly address: string | undefined;
}
