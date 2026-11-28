// This layer: the `patchBlock` orchestration — the same resolve-target → lock → snapshot →
// atomic-write pipeline as `patchFile` (via `patchFileOutcome`), but the transform resolves a
// block address instead of a `data-hr-id`. No HTML logic lives here.

import { patchFileOutcome } from "../io/patch-file";
import type { PatchOptions, PatchResult, PatchTargetInput } from "../io/contracts";
import type { PatchDeps } from "../io/ports";
import { applyBlockPatch, type BlockAction } from "./block-address";

export interface PatchBlockInput extends PatchTargetInput {
  readonly address: string;
  readonly action: BlockAction;
  /** Required for `replace`/`insertBefore`/`insertAfter`; must be absent for `delete`. */
  readonly html?: string;
}

export interface PatchBlockResult extends PatchResult {
  /** The canonical address of the block written this call — `undefined` after `delete`. */
  readonly address: string | undefined;
}

/**
 * The block-address write op: locked, snapshotted and undoable exactly like `patchFile`.
 * The transform evaluates inside the lock on the bytes actually rewritten.
 */
export const patchBlock = async (
  input: PatchBlockInput,
  deps: PatchDeps,
  options: PatchOptions = {},
): Promise<PatchBlockResult> => {
  const { result, outcome } = await patchFileOutcome(input, deps, options, (html) =>
    applyBlockPatch(
      html,
      input.html === undefined
        ? { address: input.address, action: input.action }
        : { address: input.address, action: input.action, html: input.html },
    ),
  );
  return { ...result, address: outcome.address };
};
