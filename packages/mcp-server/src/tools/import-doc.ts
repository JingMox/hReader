// This layer: `hr_import_doc` (foreign HTML → importForeign → managed document on disk); conversion and validation are all in core.
// Shares the same boundary check and errno translation as `hr_create_doc`: `outPath` is judged before writing; an existing target is rejected (`wx`).

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

/** Default landing spot: same directory as the source, same name plus a `.hr` infix (same rule as `hr import`): `a.html` → `a.hr.html`. */
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
  // The lexical check intercepts first: outPath pointing at the source means overwriting the input itself — reject before reading (same semantics as the CLI's usage error).
  if (target.absolute === source.absolute) {
    throw new HrError("invalid_input", `outPath 不能指向源文件自身：${target.input}`);
  }
  const product = importForeign(await readInsideWorkspace(source), {
    ...(args.kind === undefined ? {} : { kind: args.kind }),
    ...(args.title === undefined ? {} : { title: args.title }),
  });
  // Judge before creating: `outPath` comes from model output, and the model can be steered by injection inside documents — out-of-bounds must be rejected before any directory is made.
  await assertInsideWorkspace(target);
  await createNewFileOf(target, product.html);
  return okResult(
    { path: target.file, report: product.report },
    { ui: { resourceUri: `${UI_URI_PREFIX}${docIdOf(target.file)}` } },
  );
};

export const importDocCall = (args: ImportDocArgs): Promise<CallToolResult> =>
  guarded("hr_import_doc", () => writeImportedDocOf(args));
