// 这层管：批注纯层门面（锚定 / 模型 / 持久化 / diff / 侧车模型 / 重定位）；本组文件零 IO、零 `new Date()`。

export { matchAnchorInText, resolveAnchor } from "./anchor";
export type { AnchorDocument, AnchorFailure, AnchorResult } from "./anchor";
export { DIFF_CHAR_LIMIT, diffText } from "./diff";
export type { ChunkKind, DiffResult, TextChunk } from "./diff";
export { ANCHOR_LIMITS, NOTE_LIMIT, annotationIdOf } from "./model";
export type { Annotation, AnnotationStatus, TextAnchor } from "./model";
export { readAnnotations, writeAnnotations } from "./store";
export type { ReadResult } from "./store";
export { docRelocatorOf, elementByPath, parseSelectorPath, SELECTOR_LIMITS } from "./relocate";
export type { RelocateResult, RelocateVia, SelectorStep } from "./relocate";
export {
  parseSidecarFile,
  replyIdOf,
  serializeSidecarFile,
  SIDECAR_LIMITS,
  SIDECAR_VERSION,
} from "./sidecar-model";
export type { SidecarAnnotation, SidecarAuthor, SidecarParse, SidecarReply } from "./sidecar-model";
