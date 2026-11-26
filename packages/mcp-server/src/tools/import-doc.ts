// 这层管：`hr_import_doc`（外来 HTML → importForeign → 落盘托管文档）；转换与校验全部在 core。
// 与 `hr_create_doc` 共用同一道边界判定与 errno 翻译：`outPath` 先判再写，目标已存在即拒（`wx`）。

import { basename, dirname, extname, join } from "node:path";

import { DOC_KINDS, HrError, importForeign } from "@hreader/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { guarded, okResult } from "../errors";
import { docIdOf, UI_URI_PREFIX } from "../ui";
import {
  FILE_PATH_HINT,
  assertInsideWorkspace,
  createNewFileOf,
  documentTargetOf,
  readInsideWorkspace,
  type DocumentTarget,
} from "./target";

export const importDocShape = {
  filePath: z.string().min(1).describe(`${FILE_PATH_HINT}；指向外来 HTML 源文件`),
  kind: z
    .enum(DOC_KINDS)
    .optional()
    .describe(
      "目标形态 note/report/minutes/brief/slides（缺省 note）；slides 时每个 h1/h2 分节成一页",
    ),
  title: z
    .string()
    .min(1)
    .optional()
    .describe("覆盖文档标题；缺省依次取 <title> → 首个 <h1> → 未命名"),
  outPath: z
    .string()
    .min(1)
    .optional()
    .describe(
      `${FILE_PATH_HINT}；缺省落在源文件旁 <name>.hr.html；目标已存在即失败，不得指向源文件本身`,
    ),
};

type ImportDocArgs = z.infer<z.ZodObject<typeof importDocShape>>;

/** 缺省落点与源同目录、同名加 `.hr` 中缀（与 `hr import` 同一规则）：`a.html` → `a.hr.html`。 */
const outTargetOf = (args: ImportDocArgs, source: DocumentTarget, cwd: string): DocumentTarget => {
  if (args.outPath !== undefined) return documentTargetOf(args.outPath, cwd);
  const derived = join(
    dirname(source.absolute),
    `${basename(source.absolute, extname(source.absolute))}.hr.html`,
  );
  return documentTargetOf(derived, cwd);
};

const writeImportedDocOf = async (args: ImportDocArgs): Promise<CallToolResult> => {
  const cwd = process.cwd();
  const source = documentTargetOf(args.filePath, cwd);
  const target = outTargetOf(args, source, cwd);
  // 词法这道先拦：outPath 指向源文件 = 覆盖输入本身，先拒再读（语义同 CLI 的用法错误）。
  if (target.absolute === source.absolute) {
    throw new HrError("invalid_input", `outPath 不能指向源文件自身：${target.input}`);
  }
  const product = importForeign(await readInsideWorkspace(source), {
    ...(args.kind === undefined ? {} : { kind: args.kind }),
    ...(args.title === undefined ? {} : { title: args.title }),
  });
  // 先判定再建：`outPath` 来自模型输出，而模型可被文档里的注入操纵——越界必须先拒，不能先建目录。
  await assertInsideWorkspace(target);
  await createNewFileOf(target, product.html);
  return okResult(
    { path: target.file, report: product.report },
    { ui: { resourceUri: `${UI_URI_PREFIX}${docIdOf(target.file)}` } },
  );
};

export const importDocCall = (args: ImportDocArgs): Promise<CallToolResult> =>
  guarded("hr_import_doc", () => writeImportedDocOf(args));
