// 这层管：`hr_create_doc`（最小合法文档或按形态起稿 + 校验 + 落盘）；写作视图靠它拿到一个可读的落点。

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
import {
  FILE_PATH_HINT,
  assertInsideWorkspace,
  createNewFileOf,
  documentTargetOf,
} from "./target";

export const createDocShape = {
  filePath: z.string().min(1).describe(FILE_PATH_HINT),
  title: z
    .string()
    .min(1)
    // 块的 id 由内容派生（core `inject.ts` 的 `seedOf`：标签 + 兄弟序号 + 文本前 64 字符），而 `replace`
    // 会让被替换节点换 id（为了 patch 幂等）——所以这里必须提前说清，别让宿主缓存。
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

/** 最小合法文档 = `<article>` + `<h1>` + 一个 `<section>`，不做模板系统。
 * 骨架里只写 `<article data-hr-id="root">`：`validateDocument` 要求它存在，后续整篇替换也以它为靶。
 * 其余节点的 id 一律交给 core 的 `injectNodeIds`——本包不手写 id 规则（手写的结论必然是
 * “新建的文档对 `hr_patch_node` 只有一个靶子 `root`、大纲为空”，与 core 漂移一次就断一条链路）。 */
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
  // 形态骨架来自 core（与 `hr new` 同一份）；不给 `kind` 时仍是最小合法文档，行为不变。
  const html =
    args.kind === undefined
      ? htmlOf(args.title)
      : newDocumentHtml({ kind: args.kind, title: args.title });
  const [firstDiagnostic] = validateDocument(parseHtml(html));
  if (firstDiagnostic !== undefined) {
    throw new HrError("invalid_document", `生成的文档没过校验：${firstDiagnostic.message}`);
  }
  // 先判定再建：`filePath` 来自模型输出，而模型可被文档里的注入操纵——越界必须先拒，不能先建目录。
  await assertInsideWorkspace(target);
  await createNewFileOf(target, html);
  return okResult(
    args.kind === undefined
      ? { path: target.file, title: args.title }
      : { path: target.file, title: args.title, kind: args.kind },
    { ui: { resourceUri: `${UI_URI_PREFIX}${docIdOf(target.file)}` } },
  );
};

/** 模板由调用方给：正常路径传 `minimalDocOf`，测试传坏模板以钉住"模板坏了就报错"。 */
export const createDocWith =
  (htmlOf: (title: string) => string) =>
  (args: CreateDocArgs): Promise<CallToolResult> =>
    guarded("hr_create_doc", () => writeNewDocOf(args, htmlOf));

export const createDocCall = createDocWith(minimalDocOf);
