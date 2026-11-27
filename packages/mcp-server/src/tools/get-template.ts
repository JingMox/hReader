// This layer: `hr_get_template` (manifest + bounded member texts + asset list for one template id).

import { TEMPLATE_ID, cutAtCodePoint, readTemplate, type TemplateManifest } from "@hreader/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { foldedOf, guarded, okResult } from "../errors";
import { templateDepsOf } from "./template-deps";

export const getTemplateShape = {
  id: z
    .string()
    .min(1)
    .regex(TEMPLATE_ID)
    .describe("模板 id（小写 kebab-case）；先用 `hr_list_templates` 看可用 id"),
};

type GetTemplateArgs = z.infer<z.ZodObject<typeof getTemplateShape>>;

/** Member texts are unbounded on disk: each field is cut at this many code points with a marker, so one fat template cannot flood the context. */
const TEXT_LIMIT = 64_000;
/** Manifest strings have no schema bound either — description/name get a tighter cap, they are summaries by design. */
const MANIFEST_TEXT_LIMIT = 2_048;
const TAG_TEXT_LIMIT = 512;

const boundOf = (text: string, limit: number): string => {
  if (text.length <= limit) return text;
  const kept = cutAtCodePoint(text, limit);
  return `${kept}…[truncated ${String(text.length - kept.length)} chars]`;
};

/** Same keys as the file, with over-long free-text fields truncated in place (`entry`/`style`/`guide` only exist when authored). */
const boundedManifestOf = (manifest: TemplateManifest): TemplateManifest => ({
  ...manifest,
  name: boundOf(manifest.name, MANIFEST_TEXT_LIMIT),
  description: boundOf(manifest.description, MANIFEST_TEXT_LIMIT),
  tags: manifest.tags.map((tag) => boundOf(tag, TAG_TEXT_LIMIT)),
});

export const getTemplateCall = (args: GetTemplateArgs): Promise<CallToolResult> =>
  guarded("hr_get_template", async () => {
    const loaded = await readTemplate(
      args.id,
      { workspace: process.cwd() },
      templateDepsOf(),
    ).catch((error: unknown) => {
      // Core's messages carry absolute template paths: fold host layout before the text reaches the model.
      throw foldedOf(error);
    });
    return okResult({
      manifest: boundedManifestOf(loaded.manifest),
      source: loaded.source,
      entry: boundOf(loaded.entry, TEXT_LIMIT),
      style: loaded.style === undefined ? null : boundOf(loaded.style, TEXT_LIMIT),
      guide: loaded.guide === undefined ? null : boundOf(loaded.guide, TEXT_LIMIT),
      assets: loaded.assets,
    });
  });
