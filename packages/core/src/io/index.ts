// 这层管：io 子模块门面（编排 API + 入参/结果类型 + 默认依赖）；不承载实现逻辑。

export type {
  PatchFileInput,
  PatchOptions,
  PatchResult,
  PatchTargetInput,
  UndoResult,
} from "./contracts";
export { writeAtomic } from "./atomic";
export { isInside, isInsideOrSelf } from "./paths";
export { nodePatchDeps } from "./node-fs";
export { patchFile } from "./patch-file";
export type { Clock, FileStat, FileSystem, PatchDeps } from "./ports";
export { readTrust, writeTrust } from "./trust";
export type { TrustGrant, TrustInput, TrustLevel } from "./trust";
export { undoPatch } from "./undo";
