// This layer: `hr_get_meta` + `hr_set_meta` — the doc's row in the shared `.hreader/meta.json`
// table (tags + sourceUrl + provenance). Reads go through core's `resolveTarget` gate (the
// doc must exist and live inside the workspace); writes merge under the table lock and are
// recorded `by: "agent"`. Output follows the bounded-wire rule: tags are already capped by
// core's limits (32 × 64 code points), every free-text field still gets the standard cut.

import { sep } from "node:path";

import {
  cutAtCodePoint,
  getDocMeta,
  nodePatchDeps,
  setDocMeta,
  type DocMetaRecord,
} from "@hreader/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { guarded, okResult } from "../errors";
import { FILE_PATH_HINT, coreFailureOf, documentTargetOf } from "./target";

const FIELD_WIRE_LIMIT = 200;

export const getMetaShape = {
  filePath: z.string().min(1).describe(FILE_PATH_HINT),
};

export const setMetaShape = {
  filePath: z.string().min(1).describe(FILE_PATH_HINT),
  tags: z
    .array(z.string())
    .optional()
    .describe("整表替换标签（归一化 + 大小写不敏感去重，取先出现的写法）；不给保持原值"),
  addTags: z
    .array(z.string())
    .optional()
    .describe("追加标签（已有的大小写不敏感忽略）；最多 32 个，每个 1..64 码点"),
  removeTags: z.array(z.string()).optional().describe("移除标签（大小写不敏感）"),
  sourceUrl: z
    .string()
    .nullable()
    .optional()
    .describe("来源 URL：http/https 绝对地址（≤2048 码点，不接受含凭据）；null 清除，缺省保持"),
};

type GetMetaArgs = z.infer<z.ZodObject<typeof getMetaShape>>;
type SetMetaArgs = z.infer<z.ZodObject<typeof setMetaShape>>;

/** The record's wire body: `null` over `undefined` keeps the shape stable for tool consumers. */
const metaBody = (file: string, meta: DocMetaRecord): Record<string, unknown> => ({
  file,
  tags: meta.tags.map((tag) => cutAtCodePoint(tag, FIELD_WIRE_LIMIT)),
  sourceUrl: meta.sourceUrl ?? null,
  createdBy: meta.createdBy ?? null,
  savedAt: meta.savedAt ?? null,
});

/** `target.file` is `relative(cwd, absolute)` — echo the POSIX form, matching core's keys. */
const fileOf = (target: ReturnType<typeof documentTargetOf>): string =>
  target.file.split(sep).join("/");

export const getMetaCall = (args: GetMetaArgs): Promise<CallToolResult> =>
  guarded("hr_get_meta", async () => {
    const target = documentTargetOf(args.filePath, process.cwd());
    const got = await getDocMeta(
      { workspace: target.workspace, file: target.file },
      nodePatchDeps,
    ).catch((error: unknown) => {
      throw coreFailureOf(error, target);
    });
    return okResult({ ...metaBody(fileOf(target), got.meta), diagnostics: got.diagnostics });
  });

export const setMetaCall = (args: SetMetaArgs): Promise<CallToolResult> =>
  guarded("hr_set_meta", async () => {
    const target = documentTargetOf(args.filePath, process.cwd());
    const written = await setDocMeta(
      {
        workspace: target.workspace,
        file: target.file,
        patch: {
          ...(args.tags === undefined ? {} : { tags: args.tags }),
          ...(args.addTags === undefined ? {} : { addTags: args.addTags }),
          ...(args.removeTags === undefined ? {} : { removeTags: args.removeTags }),
          ...(args.sourceUrl === undefined ? {} : { sourceUrl: args.sourceUrl }),
        },
        by: "agent",
      },
      nodePatchDeps,
    ).catch((error: unknown) => {
      throw coreFailureOf(error, target);
    });
    return okResult({
      ...metaBody(fileOf(target), written.meta),
      changed: written.changed,
      diagnostics: written.diagnostics,
    });
  });
