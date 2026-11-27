// This layer owns the `GET /api/search` handler — query params off the URL, then
// `searchLibrary`. `q` bounds live in core (`invalid_request` → 400 via errorReply);
// the wire payload is `LibrarySearchResult` verbatim — every path in it is already
// workspace-relative, diagnostics included.

import { HrError } from "../hr-error";
import { searchLibrary, type SearchInput } from "../search";
import type { Reply } from "./contracts";
import { jsonReply, type HandlerContext } from "./handlers";

/** `?limit=` arrives as a string; NaN and non-integers are core's `invalid_request`. */
const limitOf = (raw: string | null): number | undefined => {
  if (raw === null) return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new HrError("invalid_request", "limit 必须是整数");
  }
  return parsed;
};

export const searchReply = async (ctx: HandlerContext, url: URL): Promise<Reply> => {
  const query = url.searchParams.get("q");
  if (query === null) {
    throw new HrError("invalid_request", "缺少查询参数 q");
  }
  const limit = limitOf(url.searchParams.get("limit"));
  const input: SearchInput =
    limit === undefined
      ? { workspace: ctx.workspace, query }
      : { workspace: ctx.workspace, query, limit };
  return jsonReply(200, await searchLibrary(input, ctx.deps));
};
