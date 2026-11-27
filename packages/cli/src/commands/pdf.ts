// This layer: `hr pdf` (print sheet -> session-layer bytes -> structural validation -> atomic write); no argv checks, no exit codes.

import { dirname } from "node:path";

import { HrError, nodePatchDeps } from "@hreader/core";

import { isPdfPageSize, type PdfPageSize, type RenderSource } from "../chrome/types";
import { dataPdf, humanPdf, jsonOk, type PdfReport } from "../output";
import { inspectPdfOf } from "../pdf/report";
import { foreignPlanOf } from "./export-foreign";
import {
  assertOutInsideOf,
  assertTargetFreeOf,
  assertWritableDirOf,
  printProductOf,
  writeOutOf,
} from "./export-print";

export type RenderPdf = (input: {
  /** `sheet` = the managed print sheet; `foreign` = the capability-gated raw page. */
  readonly source: RenderSource;
  readonly pageSize: PdfPageSize;
  readonly timeoutMs: number;
  /** Must be settled before work starts: it is `Page.printToPDF`'s `generateDocumentOutline`, and the protocol layer gives no default. */
  readonly outline: boolean;
  /** `true` = the print sheet carries its own `@page` size (slides), and Chrome obeys CSS; `pageSize` is then only a fallback. */
  readonly preferCSSPageSize: boolean;
}) => Promise<{ bytes: Uint8Array }>;

export interface PdfCommandInput {
  /** Absolute path: the print sheet is built by first reading the source document. */
  readonly path: string;
  /** `--page-size` verbatim: illegal values are semantic errors (`invalid_input` exit 1), not usage errors. */
  readonly pageSize: string;
  readonly timeoutMs: number;
  /** Outline toggle (default on). False under `--no-outline`: the request carries `generateDocumentOutline: false`. */
  readonly outline: boolean;
  /** `--outline` with `--no-outline`: a semantic error, reported as `invalid_input` before work starts. */
  readonly outlineConflict: boolean;
  /** Print-sheet theme: `undefined` = the document's embedded `#hr-theme` (default only when absent); explicit values are validated by core. */
  readonly visual: string | undefined;
  /** Absolute path (already realpathed by `run.ts`). */
  readonly out: string;
  readonly force: boolean;
  readonly workspace: string;
  /** User config root for global permission modes (`run.ts` resolves it at the process boundary). */
  readonly home: string;
  readonly json: boolean;
  readonly warn: (message: string) => void;
  /** The `--out` printed in the receipt (user's view): falls back to the real path when not given. */
  readonly displayOut?: string | undefined;
  /** Session-layer injection point: `run.ts` wires real Chrome, in-process tests wire a fake transport. */
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

/** The three write checks keep `hr export`'s order and meaning (io -> out-of-bounds -> exists): fail writes that cannot succeed before spending time on rendering. */
const assertPdfOutOf = async (input: PdfCommandInput): Promise<void> => {
  await assertWritableDirOf(dirname(input.out), nodePatchDeps);
  assertOutInsideOf(input.out, input.workspace);
  await assertTargetFreeOf(input.out, input.force, nodePatchDeps);
};

const productPdfOf = async (input: PdfCommandInput, pageSize: PdfPageSize): Promise<Uint8Array> => {
  // Foreign docs bypass the print sheet entirely: they render their own bytes
  // behind the permission gate (scripts never run; network only when granted;
  // sibling assets via the /f/ verdicts). preferCSSPageSize is false — there is
  // no product @page to obey, so `--page-size` keeps its meaning.
  const foreign = await foreignPlanOf({
    path: input.path,
    workspace: input.workspace,
    home: input.home,
  });
  if (foreign !== undefined) {
    const { bytes } = await input.render({
      source: { kind: "foreign", page: foreign },
      pageSize,
      timeoutMs: input.timeoutMs,
      outline: input.outline,
      preferCSSPageSize: false,
    });
    return bytes;
  }
  const product = await printProductOf({
    path: input.path,
    visual: input.visual,
    paper: pageSize,
    workspace: input.workspace,
    warn: input.warn,
  });
  const { bytes } = await input.render({
    source: { kind: "sheet", html: product.html },
    pageSize,
    timeoutMs: input.timeoutMs,
    outline: input.outline,
    preferCSSPageSize: product.slides,
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
  // Page and outline counts read the product's true values (one parse yields both); unparseable structure throws `render_empty`,
  // a `--no-outline` product has no `/Outlines` key and naturally counts 0 — no shortcut in the command layer.
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
