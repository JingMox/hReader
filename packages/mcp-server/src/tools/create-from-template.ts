// This layer: `hr_create_from_template` (draft a document from a template id + asset copy, all-or-nothing in core).

import { TEMPLATE_ID, createFromTemplate } from "@hreader/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { guarded, okResult } from "../errors";
import { docIdOf, UI_URI_PREFIX } from "../ui";
import { FILE_PATH_HINT, assertInsideWorkspace, coreFailureOf, documentTargetOf } from "./target";
import { templateDepsOf } from "./template-deps";

export const createFromTemplateShape = {
  id: z
    .string()
    .min(1)
    .regex(TEMPLATE_ID)
    .optional()
    .describe(
      "模板 id（小写 kebab-case）；缺省为 `blank-html`（干净的最小 HTML 骨架）。先用 `hr_list_templates` 看可用 id",
    ),
  target: z
    .string()
    .min(1)
    .describe(`新文档落点：${FILE_PATH_HINT}；模板的资源会落到同名 <stem>_files/ 下`),
  title: z
    .string()
    .min(1)
    .optional()
    .describe("覆盖模板自带标题（写进 `<title>` 与首个 `<h1>`）；缺省沿用模板里的标题"),
};

type CreateFromTemplateArgs = z.infer<z.ZodObject<typeof createFromTemplateShape>>;

export const createFromTemplateCall = (args: CreateFromTemplateArgs): Promise<CallToolResult> =>
  guarded("hr_create_from_template", async () => {
    const target = documentTargetOf(args.target, process.cwd());
    // Judge before creating: `target` is model output and can be steered by injected text — out-of-bounds refuses before any write.
    await assertInsideWorkspace(target);
    const result = await createFromTemplate(
      {
        id: args.id ?? "blank-html",
        target: target.file,
        ...(args.title === undefined ? {} : { title: args.title }),
      },
      { workspace: target.workspace },
      templateDepsOf(),
    ).catch((error: unknown) => {
      throw coreFailureOf(error, target);
    });
    return okResult(
      { path: result.path, bytes: result.bytes, assets: result.assets },
      { ui: { resourceUri: `${UI_URI_PREFIX}${docIdOf(result.path)}` } },
    );
  });
