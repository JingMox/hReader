// 这层管：`ops` 子模块门面；不承载实现、不读 IO。

export { buildOutline } from "./outline";
export type { Outline, OutlineNode, PendingAnnotation } from "./outline";
export { readNode } from "./readNode";
export type { ReadNodeResult } from "./readNode";
