// 这层管：io 子模块门面（编排 API + 入参/结果类型 + 默认依赖）；不承载实现逻辑。

export type {
  PatchFileInput,
  PatchOptions,
  PatchResult,
  PatchTargetInput,
  UndoResult,
} from "./contracts";
export { writeAtomic } from "./atomic";
export { isInside, isInsideOrSelf, resolveTarget } from "./paths";
export type { ResolvedTarget } from "./paths";
export { nodePatchDeps } from "./node-fs";
export { patchFile } from "./patch-file";
export type { Clock, FileStat, FileSystem, PatchDeps } from "./ports";
export {
  effectiveOf,
  levelOfScripts,
  patchDocGrant,
  readDocGrant,
  readGlobalModes,
  settingsPathOf,
  writeDocGrant,
  writeGlobalModes,
} from "./permissions";
export type {
  DocGrant,
  DocGrantPatch,
  EffectivePermissions,
  GlobalModes,
  GlobalModesPatch,
  PermissionMode,
  TrustLevel,
} from "./permissions";
export { undoPatch } from "./undo";
export {
  annotationDirOf,
  annotationFileOf,
  readSidecarFile,
  writeSidecarFile,
} from "./annotation-store";
export type { SidecarFile } from "./annotation-store";
