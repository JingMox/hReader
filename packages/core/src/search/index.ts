// This layer: the search module's public surface — the query entry plus the constants and
// types callers need to present results; internals (walk/persist/snippet) stay private.

export { searchLibrary } from "./query";
export type { LibrarySearchResult, SearchHit, SearchInput } from "./query";
export { SEARCH_LIMITS } from "./index-store";
