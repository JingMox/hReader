// This layer: `hr_outline` (outline + pending annotations); parsing and traversal are all in core.

import { buildOutline, parseHtml } from "@hreader/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { guarded, okResult } from "../errors";
import { FILE_PATH_HINT, documentTargetOf, readInsideWorkspace } from "./target";

export const outlineShape = {
  filePath: z.string().min(1).describe(FILE_PATH_HINT),
};

type OutlineArgs = z.infer<z.ZodObject<typeof outlineShape>>;

export const outlineCall = (args: OutlineArgs): Promise<CallToolResult> =>
  guarded("hr_outline", async () => {
    const text = await readInsideWorkspace(documentTargetOf(args.filePath, process.cwd()));
    return okResult(buildOutline(parseHtml(text)));
  });
