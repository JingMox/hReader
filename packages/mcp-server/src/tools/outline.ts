// 这层管：`hr_outline`（大纲 + 未处理 `pending_ai` 批注）；解析与遍历全部在 core。

import { buildOutline, parseHtml } from "@hreader/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { guarded, okResult } from "../errors";
import { documentTargetOf, readInsideWorkspace } from "./target";

export const outlineShape = {
  filePath: z
    .string()
    .min(1)
    .describe("要读结构的那份 HTML 文档的路径（工作区内，相对当前目录或绝对路径）"),
};

type OutlineArgs = z.infer<z.ZodObject<typeof outlineShape>>;

export const outlineCall = (args: OutlineArgs): Promise<CallToolResult> =>
  guarded("hr_outline", async () => {
    const text = await readInsideWorkspace(documentTargetOf(args.filePath, process.cwd()));
    return okResult(buildOutline(parseHtml(text)));
  });
