// 这层管：`hr_create_doc`（最小合法文档 + 校验 + 落盘）；写作视图靠它拿到一个可读的落点。

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { HrError, parseHtml, validateDocument } from "@hreader/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { guarded, okResult } from "../errors";
import { docIdOf, UI_URI_PREFIX } from "../ui";
import { documentTargetOf } from "./target";

export const createDocShape = {
  filePath: z
    .string()
    .min(1)
    .describe("要新建的 HTML 文档路径（相对当前目录或绝对路径）；已存在则拒绝"),
  title: z.string().min(1).describe("文档标题（写进 `<title>` 与 `<h1>`）；正文之后再靠 patch 补"),
};

type CreateDocArgs = z.infer<z.ZodObject<typeof createDocShape>>;

/** 裁定 #5：最小合法文档 = `<article>` + `<h1>` + 一个 `<section>`，不做模板系统。
 * `<article>` 的 `data-hr-id` 不是装饰：`validateDocument` 要求它存在，后续整篇替换也以它为靶。 */
const minimalDocOf = (title: string): string =>
  `<!doctype html>
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

const writeNewDocOf = async (
  args: CreateDocArgs,
  htmlOf: (title: string) => string,
): Promise<CallToolResult> => {
  const target = documentTargetOf(args.filePath, process.cwd());
  const html = htmlOf(args.title);
  const [firstDiagnostic] = validateDocument(parseHtml(html));
  if (firstDiagnostic !== undefined) {
    throw new HrError("invalid_document", `生成的文档没过校验：${firstDiagnostic.message}`);
  }
  await mkdir(dirname(target.absolute), { recursive: true });
  await writeFile(target.absolute, html, { encoding: "utf8", flag: "wx" }).catch(
    (error: unknown) => {
      throw new HrError("io_failure", `写入失败（文件已存在或不可写）：${target.file}`, {
        cause: error,
      });
    },
  );
  return okResult(
    { path: target.file, title: args.title },
    { ui: { resourceUri: `${UI_URI_PREFIX}${docIdOf(target.file)}` } },
  );
};

/** 模板由调用方给：正常路径传 `minimalDocOf`，测试传坏模板以钉住"模板坏了就报错"。 */
export const createDocWith =
  (htmlOf: (title: string) => string) =>
  (args: CreateDocArgs): Promise<CallToolResult> =>
    guarded("hr_create_doc", () => writeNewDocOf(args, htmlOf));

export const createDocCall = createDocWith(minimalDocOf);
