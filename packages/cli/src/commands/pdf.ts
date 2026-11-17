// 这层管：`hr pdf`（打印稿 → 会话层出字节 → 结构校验 → 原子写）；不判 argv、不定退出码。

import { dirname } from "node:path";

import { DEFAULT_STYLE_ID, HrError, nodePatchDeps } from "@hreader/core";

import { isPdfPageSize, type PdfPageSize } from "../chrome/cdp";
import { dataPdf, humanPdf, jsonOk, type PdfReport } from "../output";
import {
  assertOutInsideOf,
  assertTargetFreeOf,
  assertWritableDirOf,
  printProductOf,
  writeOutOf,
} from "./exportPrint";

export type RenderPdf = (input: {
  readonly html: string;
  readonly pageSize: PdfPageSize;
  readonly timeoutMs: number;
}) => Promise<{ bytes: Uint8Array }>;

export interface PdfCommandInput {
  /** 绝对路径：打印稿要先读源文档。 */
  readonly path: string;
  /** 原样的 `--page-size`：非法值属于语义错误（`invalid_input` exit 1），不是用法错误。 */
  readonly pageSize: string;
  readonly timeoutMs: number;
  /** 绝对路径（`run.ts` 已真实化）。 */
  readonly out: string;
  readonly force: boolean;
  readonly workspace: string;
  readonly json: boolean;
  readonly warn: (message: string) => void;
  /** 会话层注入点：`run.ts` 接真 Chrome，进程内测试接假传输。 */
  readonly render: RenderPdf;
}

/** `\/Type\s*\/Page\b(?!s)`：旧写法 `[^s]` 在文件以 `/Type /Page` 结尾时会漏数最后一页。 */
const PDF_PAGE = /\/Type\s*\/Page\b(?!s)/gu;

const PDF_MAGIC = "%PDF-";

const decoder = new TextDecoder("latin1");

export const pdfPagesOf = (bytes: Uint8Array): number =>
  decoder.decode(bytes).match(PDF_PAGE)?.length ?? 0;

const pageSizeOf = (value: string): PdfPageSize => {
  if (!isPdfPageSize(value)) {
    throw new HrError("invalid_input", `--page-size 只能是 a4 | letter | a5：${value}`);
  }
  return value;
};

const assertPdfOf = (bytes: Uint8Array, pages: number): void => {
  if (bytes.length === 0) throw new HrError("render_empty", "Chrome 没有返回 PDF 字节");
  if (decoder.decode(bytes.slice(0, PDF_MAGIC.length)) !== PDF_MAGIC) {
    throw new HrError("render_empty", "Chrome 返回的产物不是 PDF");
  }
  if (pages === 0) throw new HrError("render_empty", "PDF 里没有页面");
};

/** 落盘三连与 `hr export` 同序同语义（io → 越界 → 已存在）：先判掉必然失败的写，再花时间渲染。 */
const assertPdfOutOf = async (input: PdfCommandInput): Promise<void> => {
  await assertWritableDirOf(dirname(input.out), nodePatchDeps);
  assertOutInsideOf(input.out, input.workspace);
  await assertTargetFreeOf(input.out, input.force, nodePatchDeps);
};

const productPdfOf = async (
  input: PdfCommandInput,
  pageSize: PdfPageSize,
): Promise<{ bytes: Uint8Array }> => {
  const product = await printProductOf({
    path: input.path,
    visual: DEFAULT_STYLE_ID,
    paper: pageSize,
    workspace: input.workspace,
    warn: input.warn,
  });
  return input.render({ html: product.html, pageSize, timeoutMs: input.timeoutMs });
};

export const pdfCommand = async (input: PdfCommandInput): Promise<string> => {
  const pageSize = pageSizeOf(input.pageSize);
  await assertPdfOutOf(input);
  const { bytes } = await productPdfOf(input, pageSize);
  const pages = pdfPagesOf(bytes);
  assertPdfOf(bytes, pages);
  await writeOutOf({
    path: input.out,
    workspace: input.workspace,
    data: bytes,
    what: "写入 PDF",
  });
  const report: PdfReport = {
    base64: Buffer.from(bytes).toString("base64"),
    bytes: bytes.length,
    pages,
    out: input.out,
  };
  return input.json ? jsonOk(dataPdf(report)) : humanPdf(report);
};
