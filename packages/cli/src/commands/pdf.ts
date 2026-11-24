// 这层管：`hr pdf`（打印稿 → 会话层出字节 → 结构校验 → 原子写）；不判 argv、不定退出码。

import { dirname } from "node:path";

import { DEFAULT_STYLE_ID, HrError, nodePatchDeps } from "@hreader/core";

import { isPdfPageSize, type PdfPageSize } from "../chrome/types";
import { dataPdf, humanPdf, jsonOk, type PdfReport } from "../output";
import { inspectPdfOf } from "../pdf/report";
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
  /** 开工前就要定下来：它是 `Page.printToPDF` 的 `generateDocumentOutline`，协议层不给默认值。 */
  readonly outline: boolean;
}) => Promise<{ bytes: Uint8Array }>;

export interface PdfCommandInput {
  /** 绝对路径：打印稿要先读源文档。 */
  readonly path: string;
  /** 原样的 `--page-size`：非法值属于语义错误（`invalid_input` exit 1），不是用法错误。 */
  readonly pageSize: string;
  readonly timeoutMs: number;
  /** 大纲开关（缺省开）。`--no-outline` 时为 false：请求里就是 `generateDocumentOutline: false`。 */
  readonly outline: boolean;
  /** `--outline` 与 `--no-outline` 同传：语义错误，开工前报 `invalid_input`。 */
  readonly outlineConflict: boolean;
  /** 绝对路径（`run.ts` 已真实化）。 */
  readonly out: string;
  readonly force: boolean;
  readonly workspace: string;
  readonly json: boolean;
  readonly warn: (message: string) => void;
  /** 回执里印的 `--out`（用户视角）：不给就印真实路径。 */
  readonly displayOut?: string | undefined;
  /** 会话层注入点：`run.ts` 接真 Chrome，进程内测试接假传输。 */
  readonly render: RenderPdf;
}

const PDF_MAGIC = "%PDF-";

const decoder = new TextDecoder("latin1");

const pageSizeOf = (value: string): PdfPageSize => {
  if (!isPdfPageSize(value)) {
    throw new HrError("invalid_input", `--page-size 只能是 a4 | letter | a5：${value}`);
  }
  return value;
};

const assertPdfHeaderOf = (bytes: Uint8Array): void => {
  if (bytes.length === 0) throw new HrError("render_empty", "Chrome 没有返回 PDF 字节");
  if (decoder.decode(bytes.slice(0, PDF_MAGIC.length)) !== PDF_MAGIC) {
    throw new HrError("render_empty", "Chrome 返回的产物不是 PDF");
  }
};

/** 落盘三连与 `hr export` 同序同语义（io → 越界 → 已存在）：先判掉必然失败的写，再花时间渲染。 */
const assertPdfOutOf = async (input: PdfCommandInput): Promise<void> => {
  await assertWritableDirOf(dirname(input.out), nodePatchDeps);
  assertOutInsideOf(input.out, input.workspace);
  await assertTargetFreeOf(input.out, input.force, nodePatchDeps);
};

const productPdfOf = async (input: PdfCommandInput, pageSize: PdfPageSize): Promise<Uint8Array> => {
  const product = await printProductOf({
    path: input.path,
    visual: DEFAULT_STYLE_ID,
    paper: pageSize,
    workspace: input.workspace,
    warn: input.warn,
  });
  const { bytes } = await input.render({
    html: product.html,
    pageSize,
    timeoutMs: input.timeoutMs,
    outline: input.outline,
  });
  return bytes;
};

export const pdfCommand = async (input: PdfCommandInput): Promise<string> => {
  const pageSize = pageSizeOf(input.pageSize);
  if (input.outlineConflict) {
    throw new HrError("invalid_input", "--outline 与 --no-outline 不能同时使用");
  }
  await assertPdfOutOf(input);
  const bytes = await productPdfOf(input, pageSize);
  assertPdfHeaderOf(bytes);
  // 页数与大纲数读的是产物真值（一次解析两个口径都出来）；结构读不出抛 `render_empty`，
  // `--no-outline` 的产物里没有 `/Outlines` 键，大纲自然得 0，命令层不做短路。
  const facts = await inspectPdfOf(bytes);
  if (facts.pages === 0) throw new HrError("render_empty", "PDF 里没有页面");
  const pages = facts.pages;
  const outline = facts.outline;
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
    outline,
    out: input.out,
  };
  return input.json ? jsonOk(dataPdf(report)) : humanPdf(report, input.displayOut ?? report.out);
};
