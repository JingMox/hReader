// 这层管：`HreaderPatchRequestShape` 不许比 core 的 `PatchRequest` 多出任何字段（含可选字段）。
// `drift.test-d.ts` 的双向赋值抓不到"多一个可选字段"：可选字段不破坏双向可赋值性，
// 所以镜像会静默分叉。这条用 `keyof` 差集把"多出来的键"钉成 `never`。

import type { PatchRequest as CorePatchRequest } from "@hreader/core";

import type { HreaderPatchRequestShape } from "../src/events";

/** 镜像里有、core 没有的键；多出任何键（不论是否可选）都不会是 `never`。 */
type ExtraKeys = Exclude<keyof HreaderPatchRequestShape, keyof CorePatchRequest>;

export const hasNoExtraKeys: [ExtraKeys] extends [never] ? true : false = true;
