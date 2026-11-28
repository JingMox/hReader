// This layer: the block-address facade — pure HTML-string functions for addressing one leaf
// block of any document (`css:<path>@<fingerprint>`), plus the splice that rewrites it.

export { listBlocks } from "./blocks";
export { resolveAddress } from "./resolve";
export { applyBlockPatch } from "./apply";
export type {
  BlockAction,
  BlockInfo,
  BlockPatchOutcome,
  BlockPatchRequest,
  ResolveResult,
} from "./constants";
