// 这层管：`ops` 子模块门面；不承载实现、不读 IO。

export { buildOutline } from "./outline";
export type { Outline, OutlineNode, PendingAnnotation } from "./outline";
export { readNode } from "./read-node";
export type { ReadNodeResult } from "./read-node";
export { locateTarget, patchTargetIdOf } from "./locate";
export type { LocatedTarget } from "./locate";
export { applyPatch, parseFragment } from "./patch-node";
export type { PatchAction, PatchOutcome, PatchRequest } from "./patch-node";
export { importForeign } from "./import";
export type { ImportDiscard, ImportOptions, ImportReport, ImportResult } from "./import";
