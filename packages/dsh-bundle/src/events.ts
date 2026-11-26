// The plugin's type contract with the host (events + services). Only the compiler can verify it,
// hence the dedicated file.
//
// This file must **not** import types from `@hreader/core`: core is only a `workspace:*` devDependency
// in package.json, and once it lands in `dist/events.d.ts`, anyone installing into a profile gets a tsc
// `Cannot find module '@hreader/core'`. Same for `@deepseek-ai/*` (they are not in `dependencies`, and one
// bare `import type` in the declaration file is enough to throw TS2307 on a user with only this package
// installed). External shapes are mirrored locally, with tests watching for drift; the one exception is
// the bare `import type {}` seed below (binds nothing and is wiped from the d.ts by tsc — see the site).

/**
 * Mirror of `PatchAction`: fields and values align verbatim with `packages/core/src/ops/patch-node/constants.ts:3`.
 */
export type HreaderPatchAction = "replace" | "insert_before" | "insert_after" | "append" | "delete";

/**
 * Mirror of `PatchRequest` (same structure, fields and optionality verbatim):
 * source is `packages/core/src/ops/patch-node/constants.ts:5`. Drift is caught by two assertions:
 * fields and optionality via the two-way subtyping in `tests/drift.test-d.ts`, **extra optional fields**
 * via the `keyof` difference in `tests/shape-no-extra-keys.test-d.ts` (an optional addition is invisible
 * to two-way assignability).
 */
export interface HreaderPatchRequestShape {
  /** The target's `data-hr-id`; `"root"` means the outermost `<article>` itself (attributes kept). */
  readonly targetId: string;
  readonly action: HreaderPatchAction;
  /** Required for replace / insert_before / insert_after / append; must be absent for delete. */
  readonly html?: string;
}

/**
 * Payload of `hreader/patch-request`: the host hands a patch request to hreader's patch engine.
 * The module name must be `@deepseek-ai/cordis` (the release line dsh actually resolves, not `cordis`) —
 * writing `cordis` errors nothing, it just silently disables the whole `Events` merge.
 */
export interface HreaderPatchRequest {
  /**
   * hreader workspace root. Being inside it is guaranteed by the consumer's write side:
   * lexical + realpath checks in `packages/core/src/io/paths.ts:73-79` (`resolveTarget`),
   * parent-directory re-check before write in `packages/core/src/io/atomic.ts`. This package only
   * reads style files and never writes.
   */
  readonly workspace: string;
  readonly request: HreaderPatchRequestShape;
}

/** The read-only surface `ctx.provide('hreader', …)` exposes to other plugins. */
export interface HreaderService {
  readonly styleId: string;
  /** The compiled language-spec text (`compileTone` output, byte-for-byte). */
  readonly prompt: string;
}

/**
 * Mirror of `ctx.systemPrompt.section()`'s parameter shape: same structure, fields verbatim with the
 * official `PromptSection` (`lib/types/index.d.ts:47` of `@deepseek-ai/dsh-system-prompt@0.2.2-rc.1`).
 * The official type is not used because it would drag a bare dependency into `dist/events.d.ts` (see
 * the header). Drift is watched by `tests/drift.test-d.ts`: an official type change to
 * `name`/`order`/`text` turns that assignment red.
 */
export interface HreaderPromptSection {
  readonly name: string;
  readonly order: number;
  readonly text: string;
}

/**
 * The `import type {}` is not leftover: the `declare module "@deepseek-ai/cordis"` below is only a
 * merge declaration and does **not itself load** cordis's augmentation chain (`lib/types/events.d.ts`,
 * `fiber.d.ts`, `reflect.d.ts` each `declare module './context.ts'`). Without this line, the `Context`
 * this package sees is only the base surface (`emit`/`provide`/`effect` all missing) and
 * `tests/types.test-d.ts` turns TS2349/TS2339 red. tsc wipes the empty binding from `dist/events.d.ts`
 * entirely, so the user side still has zero bare dependencies (`tests/dist.test.ts` watches).
 */
import type {} from "@deepseek-ai/cordis";

declare module "@deepseek-ai/cordis" {
  interface Context {
    hreader: HreaderService;
  }

  interface Events {
    "hreader/patch-request"(payload: HreaderPatchRequest): void;
  }
}
