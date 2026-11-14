// 这层管：批注纯层门面（锚定 / 模型 / 持久化 / diff）；本组文件零 IO、零 `new Date()`。

export { resolveAnchor } from "./anchor";
export type { AnchorDocument, AnchorFailure, AnchorResult } from "./anchor";
export { DIFF_CHAR_LIMIT, diffText } from "./diff";
export type { ChunkKind, DiffResult, TextChunk } from "./diff";
export { ANCHOR_LIMITS, NOTE_LIMIT, annotationIdOf } from "./model";
export type { Annotation, AnnotationStatus, TextAnchor } from "./model";
export { readAnnotations, writeAnnotations } from "./store";
export type { ReadResult } from "./store";
