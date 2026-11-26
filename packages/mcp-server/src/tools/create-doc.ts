// This layer: `hr_create_doc` (minimal valid document, or a kind-shaped draft + validation + write); the writing view relies on it for a readable landing spot.

import {
  DOC_KINDS,
  HrError,
  injectNodeIds,
  newDocumentHtml,
  parseHtml,
  serializeHtml,
  validateDocument,
} from "@hreader/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { guarded, okResult } from "../errors";
import { docIdOf, UI_URI_PREFIX } from "../ui";
import { FILE_PATH_HINT, assertInsideWorkspace, createNewFileOf, documentTargetOf } from "./target";

export const createDocShape = {
  filePath: z.string().min(1).describe(FILE_PATH_HINT),
  title: z
    .string()
    .min(1)
    // Block ids derive from content (core `inject.ts`'s `seedOf`: tag + sibling index + first 64 chars of text), and `replace`
    // gives the replaced node a new id (for patch idempotence) — so this must be said up front; the host must not cache them.
    .describe(
      "文档标题（写进 `<title>` 与 `<h1>`）；正文之后再靠 patch 补。" +
        "新建文档的块 id 由内容派生：首次写入正文后 id 会变，" +
        "请以 `hr_outline`/`hr_read_node` 的最新 id 为准，不要缓存返回值里的 id。",
    ),
  kind: z
    .enum(DOC_KINDS)
    .optional()
    .describe(
      "文档形态：note 笔记 / report 报告 / minutes 会议纪要 / brief 决策简报 / slides 幻灯片" +
        "（每个顶层 `<section>` 一页）。给了就按该形态写一份带组件占位的起稿骨架，" +
        "占位文字在全角括号里，逐块 `hr_patch_node` 替换即可；不给则只建最小空文档。",
    ),
};

type CreateDocArgs = z.infer<z.ZodObject<typeof createDocShape>>;

/** Minimal valid document = `<article>` + `<h1>` + one `<section>`; no template system.
 * The skeleton only writes `<article data-hr-id="root">`: `validateDocument` requires it, and later whole-document replaces target it.
 * All other node ids come from core's `injectNodeIds` — this package never handwrites id rules (a handwritten conclusion is necessarily
 * "a fresh document offers `hr_patch_node` only the `root` target and an empty outline", and one drift from core breaks the chain). */
const skeletonOf = (title: string): string => `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>${title}</title>
</head>
<body>
<article data-hr-id="root">
<h1>${title}</h1>
<section>
<p></p>
</section>
</article>
</body>
</html>
`;

const minimalDocOf = (title: string): string =>
  serializeHtml(injectNodeIds(parseHtml(skeletonOf(title))).parsed);

const writeNewDocOf = async (
  args: CreateDocArgs,
  htmlOf: (title: string) => string,
): Promise<CallToolResult> => {
  const target = documentTargetOf(args.filePath, process.cwd());
  // Kind skeletons come from core (same as `hr new`); without `kind` it is still the minimal document — behavior unchanged.
  const html =
    args.kind === undefined
      ? htmlOf(args.title)
      : newDocumentHtml({ kind: args.kind, title: args.title });
  const [firstDiagnostic] = validateDocument(parseHtml(html));
  if (firstDiagnostic !== undefined) {
    throw new HrError("invalid_document", `生成的文档没过校验：${firstDiagnostic.message}`);
  }
  // Judge before creating: `filePath` comes from model output, and the model can be steered by injection inside documents — out-of-bounds must be rejected before any directory is made.
  await assertInsideWorkspace(target);
  await createNewFileOf(target, html);
  return okResult(
    args.kind === undefined
      ? { path: target.file, title: args.title }
      : { path: target.file, title: args.title, kind: args.kind },
    { ui: { resourceUri: `${UI_URI_PREFIX}${docIdOf(target.file)}` } },
  );
};

/** The template is supplied by the caller: the normal path passes `minimalDocOf`; tests pass a broken template to pin "a bad template errors out". */
export const createDocWith =
  (htmlOf: (title: string) => string) =>
  (args: CreateDocArgs): Promise<CallToolResult> =>
    guarded("hr_create_doc", () => writeNewDocOf(args, htmlOf));

export const createDocCall = createDocWith(minimalDocOf);
