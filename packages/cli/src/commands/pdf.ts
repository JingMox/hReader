// 这层管：`hr pdf`（打印稿 → 会话层出字节 → 结构校验 → 原子写）；不判 argv、不定退出码。

import { dirname } from "node:path";

import { DEFAULT_STYLE_ID, HrError, nodePatchDeps, parseHtml } from "@hreader/core";

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
  /** 会话层注入点：`run.ts` 接真 Chrome，进程内测试接假传输。 */
  readonly render: RenderPdf;
}

/** `\/Type\s*\/Page\b(?!s)`：旧写法 `[^s]` 在文件以 `/Type /Page` 结尾时会漏数最后一页。 */
const PDF_PAGE = /\/Type\s*\/Page\b(?!s)/gu;

const PDF_MAGIC = "%PDF-";

/** 打印稿的 heading 数（h1–h6）：M4.3 保证产物里 `<h1..h6>` 元素总数 == 大纲条目数（AC-4）。 */
const HEADING_TAGS: ReadonlySet<string> = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

type HtmlNode = ReturnType<typeof parseHtml>["root"];

const decoder = new TextDecoder("latin1");

export const pdfPagesOf = (bytes: Uint8Array): number =>
  decoder.decode(bytes).match(PDF_PAGE)?.length ?? 0;

const headingsOf = (node: HtmlNode): number => {
  if (node.kind !== "element" && node.kind !== "document") return 0;
  const self = node.kind === "element" && HEADING_TAGS.has(node.tag) ? 1 : 0;
  return self + node.children.reduce((sum, child) => sum + headingsOf(child), 0);
};

/**
 * 数 `parseHtml` 树上的 heading **元素**，不数字典里的 `buildOutline().nodes`：
 * 后者会因 `OUTLINE_DEPTH_LIMIT` 与缺 `data-hr-id` 省略而比产物少，报告值就跟着小了。
 *
 * 这个数是"打印稿里 `h1–h6` 元素的个数"，是个**近似值而非产物真值**：`display: none` 的标题
 * 仍会被计入，而 Chrome 不会为它生成书签（真机测到的唯一不一致点）。
 */
export const pdfHeadingsOf = (html: string): number => headingsOf(parseHtml(html).root);

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
): Promise<{ bytes: Uint8Array; outline: number }> => {
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
  // `--no-outline` 时产物里不会有书目，报告值必须跟请求一致，不能报“文档本来有几个 heading”。
  return { bytes, outline: input.outline ? pdfHeadingsOf(product.html) : 0 };
};

export const pdfCommand = async (input: PdfCommandInput): Promise<string> => {
  const pageSize = pageSizeOf(input.pageSize);
  if (input.outlineConflict) {
    throw new HrError("invalid_input", "--outline 与 --no-outline 不能同时使用");
  }
  await assertPdfOutOf(input);
  const { bytes, outline } = await productPdfOf(input, pageSize);
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
    outline,
    out: input.out,
  };
  return input.json ? jsonOk(dataPdf(report)) : humanPdf(report);
};
