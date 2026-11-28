// This layer owns the document-metadata HTTP handlers — `GET`/`POST /api/doc/<docId>/meta`
// over the shared `.hreader/meta.json` table. They produce `Reply`/`Written` only, never a
// socket. The HTML file is never touched: `changed:false` keeps doc.changed silent, and a
// record-changing write broadcasts the dedicated `doc.meta` event (dispatched in runtime,
// gated on `metaChanged`).

import { z } from "zod";

import type { DocMetaRecord } from "../docmeta";
import { getDocMeta, setDocMeta } from "../ops/doc-meta-ops";
import { parseBody } from "./body";
import type { Reply } from "./contracts";
import { busy, jsonReply, targetOf, type HandlerContext, type Written } from "./handlers";
import { revisionOf } from "./revision";

/**
 * The wire shape of one record: `tags` always present; the optional fields ride along as
 * explicit `null` when absent so consumers get a stable shape either way.
 */
const metaBody = (meta: DocMetaRecord): Record<string, unknown> => ({
  tags: [...meta.tags],
  sourceUrl: meta.sourceUrl ?? null,
  createdBy: meta.createdBy ?? null,
  savedAt: meta.savedAt ?? null,
});

/** `GET /api/doc/<docId>/meta`: the doc's record, or all-empty fields when it has none. */
export const docMetaReply = async (ctx: HandlerContext, docId: string): Promise<Reply> => {
  await targetOf(ctx, docId);
  const got = await getDocMeta({ workspace: ctx.workspace, file: docId }, ctx.deps);
  return jsonReply(200, { ...metaBody(got.meta), diagnostics: got.diagnostics });
};

// ---- write body: strict zod — unknown keys die; semantic bounds are the ops layer's ----

const docMetaBody = z
  .object({
    docId: z.string().optional(),
    tags: z.array(z.string()).optional(),
    addTags: z.array(z.string()).optional(),
    removeTags: z.array(z.string()).optional(),
    // `null` is the documented "clear" value; a missing key keeps the stored URL.
    sourceUrl: z.string().nullable().optional(),
  })
  .strict();

/**
 * The write receipt shares the read shape plus `changed`/`revision` (`revisionOf` semantics
 * unchanged — a meta write does not touch document bytes, so it reads as "the current
 * version"). `changed:false` on `Written` keeps doc.changed silent; broadcasting is
 * doc.meta's job in the runtime dispatch.
 */
export const docMetaSetReply = async (
  ctx: HandlerContext,
  docId: string,
  body: Readonly<Record<string, unknown>>,
  lockMs: number,
): Promise<Written> => {
  const input = parseBody(docMetaBody, body);
  const target = await targetOf(ctx, docId);
  const result = await busy(() =>
    setDocMeta(
      {
        workspace: ctx.workspace,
        file: docId,
        patch: {
          ...(input.tags === undefined ? {} : { tags: input.tags }),
          ...(input.addTags === undefined ? {} : { addTags: input.addTags }),
          ...(input.removeTags === undefined ? {} : { removeTags: input.removeTags }),
          ...(input.sourceUrl === undefined ? {} : { sourceUrl: input.sourceUrl }),
        },
        by: "user",
      },
      ctx.deps,
      { lockTimeoutMs: lockMs },
    ),
  );
  const revision = revisionOf(await ctx.deps.fs.readFile(target.realPath));
  return {
    reply: jsonReply(200, {
      ...metaBody(result.meta),
      changed: result.changed,
      revision,
      diagnostics: result.diagnostics,
    }),
    target,
    revision,
    changed: false,
    changedNodes: [],
    metaChanged: result.changed,
  };
};
