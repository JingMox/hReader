// Pure annotation facade (anchoring / model / persistence / diff / sidecar model / relocation); no IO
// and no `new Date()` anywhere in this group of files.

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
