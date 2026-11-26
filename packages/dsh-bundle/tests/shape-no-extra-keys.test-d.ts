// `HreaderPatchRequestShape` must not carry any field (optional included) beyond core's
// `PatchRequest`. The two-way assignment in `drift.test-d.ts` cannot catch "one extra optional
// field": an optional field does not break two-way assignability, so the mirror would fork silently.
// This one pins "extra keys" to `never` via a `keyof` difference.

import type { PatchRequest as CorePatchRequest } from "@hreader/core";

import type { HreaderPatchRequestShape } from "../src/events";

/** Keys the mirror has but core does not; any extra key (optional or not) is never `never`. */
type ExtraKeys = Exclude<keyof HreaderPatchRequestShape, keyof CorePatchRequest>;

export const hasNoExtraKeys: [ExtraKeys] extends [never] ? true : false = true;
