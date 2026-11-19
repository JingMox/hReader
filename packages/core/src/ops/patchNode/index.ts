// 这层管：ops/patchNode 的门面（对外暴露 applyPatch / parseFragment 与请求/结果类型）。

export { applyPatch } from "./apply";
export type { PatchAction, PatchOutcome, PatchRequest, ReplacedId } from "./constants";
export { parseFragment } from "./fragment";
