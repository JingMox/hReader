// This layer: the docmeta module's public surface — record/limits/normalizers and the
// file-table parse/serialize; internals stay private to model.ts.

export {
  DOC_META_CREATORS,
  DOC_META_LIMITS,
  DOC_META_VERSION,
  docMetaRecordJson,
  foldTag,
  normalizeTag,
  parseDocMetaFile,
  serializeDocMetaFile,
  sourceUrlOf,
} from "./model";
export type { DocMetaCreator, DocMetaParse, DocMetaPatch, DocMetaRecord } from "./model";
