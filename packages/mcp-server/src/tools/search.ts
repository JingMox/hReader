// This layer: `hr_search` — the workspace-wide full-text search over documents and their
// annotations. The wire output follows annotation-wire's rule: every free-text field is
// cut to a fixed cap so one fat document cannot flood the result; paths stay
// workspace-relative (core's contract — diagnostics included).

import {
  SEARCH_LIMITS,
  cutAtCodePoint,
  nodePatchDeps,
  searchLibrary,
  type SearchHit,
} from "@hreader/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { foldedOf, guarded, okResult } from "../errors";

const FIELD_WIRE_LIMIT = 200;

export const searchShape = {
  query: z
    .string()
    .min(1)
    .refine((value) => Array.from(value).length <= SEARCH_LIMITS.queryChars, {
      message: `查询词最多 ${String(SEARCH_LIMITS.queryChars)} 个码点`,
    })
    .describe(
      `查询词（1..${String(SEARCH_LIMITS.queryChars)} 码点）；≥2 码点的词带前缀匹配，拉丁词另有 0.2 模糊，CJK 词精确；多词先按 AND 合并、落空再按 OR`,
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(SEARCH_LIMITS.limitMax)
    .optional()
    .describe(`返回条数上限 1..${String(SEARCH_LIMITS.limitMax)}（默认 20）`),
};

type SearchArgs = z.infer<z.ZodObject<typeof searchShape>>;

const cut = (text: string): string => cutAtCodePoint(text, FIELD_WIRE_LIMIT);

const hitBody = (hit: SearchHit): Record<string, unknown> => ({
  path: cut(hit.path),
  title: cut(hit.title),
  kind: hit.kind,
  ...(hit.annotationId === undefined ? {} : { annotationId: cut(hit.annotationId) }),
  score: hit.score,
  snippet: cut(hit.snippet),
  highlights: hit.highlights,
});

export const searchCall = (args: SearchArgs): Promise<CallToolResult> =>
  guarded("hr_search", async () => {
    const result = await searchLibrary(
      {
        workspace: process.cwd(),
        query: args.query,
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      },
      nodePatchDeps,
    ).catch((error: unknown) => {
      // Core messages can carry the workspace root: fold it like listWorkspaceAnnotations does.
      throw foldedOf(error);
    });
    return okResult({
      results: result.results.map(hitBody),
      total: result.total,
      combine: result.combine,
      truncated: result.truncated,
      diagnostics: result.diagnostics.slice(0, SEARCH_LIMITS.diagnostics),
    });
  });
