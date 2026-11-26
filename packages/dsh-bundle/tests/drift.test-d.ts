// The "shape mirrors" in `events.ts` must not drift from the upstream real types.
// This package cannot take types from `@hreader/core` (a `workspace:*` devDependency; landing in the
// dist declaration files means "Cannot find module '@hreader/core'") nor from `@deepseek-ai/*` (same
// reason, and they are `devDependencies`) — so it restates the shapes itself; the price is that
// assertions **must** watch them.
// `tsc` runs it, vitest does not (not a `*.test.ts`), and it never enters `dist/` (build compiles
// only `src/`).

import type { PromptSection } from "@deepseek-ai/dsh-system-prompt";
import type { PatchRequest as CorePatchRequest } from "@hreader/core";

import type {
  HreaderPatchAction,
  HreaderPatchRequestShape,
  HreaderPromptSection,
} from "../src/events";

/** Two-way subtyping: `true` only when both sides assign to each other (= structural equality). */
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** One-way subtyping: the mirror must be an **assignable** subset of upstream (`apply` hands it to the host). */
type Assignable<A, B> = [A] extends [B] ? true : false;

/** If core changes any field/optionality of `PatchRequest`, this `true` no longer fits `false` (TS2322). */
export const requestShapeIsMutual: Mutual<HreaderPatchRequestShape, CorePatchRequest> = true;

/** The `action` value set is pinned too: core adding/removing an action turns this red. */
export const actionIsMutual: Mutual<HreaderPatchAction, CorePatchRequest["action"]> = true;

/** If the official `PromptSection` changes the types of `name`/`order`/`text`, this turns red (`order: string` is red). */
export const promptSectionIsAccepted: Assignable<HreaderPromptSection, PromptSection> = true;

/**
 * The reverse cannot assert "mutual assignability": the official `text` also allows
 * `(context) => string` plus an optional `interpolate` (`lib/types/index.d.ts:47-62`), and the mirror
 * deliberately covers only the "static text" half. The reverse risk — "the mirror grew keys" — is
 * caught by the `MIRROR_KEYS` difference.
 */
type ExtraPromptSectionKeys = Exclude<keyof HreaderPromptSection, keyof PromptSection>;
export const promptSectionHasNoExtraKeys: [ExtraPromptSectionKeys] extends [never] ? true : false =
  true;
