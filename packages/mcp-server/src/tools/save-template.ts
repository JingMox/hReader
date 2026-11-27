// This layer: `hr_save_template` (page + `<stem>_files/` -> a staged template dir, published by one rename).

import { TEMPLATE_ID, saveTemplate } from "@hreader/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { guarded, okResult } from "../errors";
import { FILE_PATH_HINT, assertInsideWorkspace, coreFailureOf, documentTargetOf } from "./target";
import { templateDepsOf } from "./template-deps";

/** `style`/`guide` come in as model-generated text: bound each at 1 MiB so a runaway payload cannot ride in on a tool arg. */
const MAX_TEXT_BYTES = 1_048_576;

const encoder = new TextEncoder();

const boundedTextArg = (label: string) =>
  z
    .string()
    .refine(
      (value) => encoder.encode(value).byteLength <= MAX_TEXT_BYTES,
      `${label} 超过 ${String(MAX_TEXT_BYTES)} 字节上限`,
    )
    .optional();

export const saveTemplateShape = {
  file: z.string().min(1).describe(`来源页面：${FILE_PATH_HINT}`),
  id: z
    .string()
    .min(1)
    .regex(TEMPLATE_ID)
    .describe("新模板 id（小写 kebab-case，≤64 字符）；目标已存在时报 file_exists，无覆盖参数"),
  global: z
    .boolean()
    .optional()
    .describe("true 存到用户层 `~/.hreader/templates/`（跨工作区可用）；缺省 false = 工作区层"),
  name: z.string().min(1).optional().describe("显示名（缺省取 id）"),
  description: z.string().min(1).optional().describe("一句话说明（缺省自动生成）"),
  style: boundedTextArg("style").describe(
    '覆盖自动提取的 `<style id="hr-theme">` 内容；需离线自足（无 `@import`/外链/`<`）',
  ),
  guide: boundedTextArg("guide").describe("覆盖自动生成的 guide.md 草稿"),
};

type SaveTemplateArgs = z.infer<z.ZodObject<typeof saveTemplateShape>>;

/** The landing dir is a fixed convention (`<root>/.hreader/templates/<id>`): report it without leaking host absolute paths to the model. */
const dirLabelOf = (scope: "workspace" | "user", id: string): string =>
  `${scope === "user" ? "~/" : ""}.hreader/templates/${id}`;

export const saveTemplateCall = (args: SaveTemplateArgs): Promise<CallToolResult> =>
  guarded("hr_save_template", async () => {
    const target = documentTargetOf(args.file, process.cwd());
    // The source is read (not written), but the boundary rule is the same: an outside file is refused before core ever sees it.
    await assertInsideWorkspace(target);
    const saved = await saveTemplate(
      {
        file: target.file,
        id: args.id,
        global: args.global ?? false,
        ...(args.name === undefined ? {} : { name: args.name }),
        ...(args.description === undefined ? {} : { description: args.description }),
        ...(args.style === undefined ? {} : { style: args.style }),
        ...(args.guide === undefined ? {} : { guide: args.guide }),
      },
      { workspace: target.workspace },
      templateDepsOf(),
    ).catch((error: unknown) => {
      throw coreFailureOf(error, target);
    });
    return okResult({
      id: saved.id,
      dir: dirLabelOf(saved.scope, saved.id),
      format: saved.format,
      scope: saved.scope,
      assets: saved.assets,
    });
  });
