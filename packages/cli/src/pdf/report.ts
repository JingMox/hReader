// 这层管：读 PDF 产物的真值（页数 + 大纲条目数）；只读，读不出来一律抛 `render_empty`。
//
// 解析交给 pdf-lib（`throwOnInvalidObject` 严格模式：畸形字节直接报错，不做恢复、
// 不向 console 吐警告）；这里只做语义——从 Catalog 的 `/Outlines` 进树、`/First`/`/Next`
// 走链数条目、跟 `/Count` 对账。
//
// 与 `tests/helpers/pdf-scan.ts` **刻意不共用代码**：那份是测试侧独立 oracle，
// 共用的话"src 读错、oracle 也读错"会一起绿。

import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef } from "pdf-lib";

import { HrError } from "@hreader/core";

import { firstErrorLineOf, messageOf } from "../errors";

const failOf = (reason: string): HrError =>
  new HrError("render_empty", `PDF 大纲结构解析不出：${reason}`);

interface PdfFacts {
  readonly pages: number;
  readonly outline: number;
}

/** 严格解析：`throwOnInvalidObject` 下畸形字节当场抛错（且无 console.warn 副作用）。 */
const loadOf = async (bytes: Uint8Array): Promise<PDFDocument> => {
  try {
    return await PDFDocument.load(bytes, { throwOnInvalidObject: true });
  } catch (error: unknown) {
    throw new HrError("render_empty", `PDF 结构解析不出：${firstErrorLineOf(messageOf(error))}`);
  }
};

const referenceOf = (entries: PDFDict, key: string): PDFRef | undefined => {
  const value = entries.get(PDFName.of(key));
  return value instanceof PDFRef ? value : undefined;
};

const nameOf = (entries: PDFDict, key: string): string | undefined => {
  const value = entries.get(PDFName.of(key));
  return value instanceof PDFName ? value.asString() : undefined;
};

const dictionaryOf = (document: PDFDocument, ref: PDFRef, what: string): PDFDict => {
  const value = document.context.lookup(ref);
  if (value === undefined) throw failOf(`找不到 ${what} 对象 ${String(ref.objectNumber)}`);
  if (!(value instanceof PDFDict)) {
    throw failOf(`${what} 对象 ${String(ref.objectNumber)} 不是字典`);
  }
  return value;
};

interface ItemsContext {
  readonly document: PDFDocument;
  /** 见过的条目对象号：唯一的终止守卫——合法遍历里每条目各占一个对象号，重复就是环。 */
  readonly seen: Set<number>;
}

/** 跟 `/Next` 走同级链、跟 `/First` 进子层；两个引用都没有就是链尾，正常收尾。 */
const countItemsOf = (context: ItemsContext, first: PDFRef | undefined): number => {
  let count = 0;
  let current = first;
  while (current !== undefined) {
    if (context.seen.has(current.objectNumber)) {
      throw failOf(`条目 ${String(current.objectNumber)} 被重复引用`);
    }
    context.seen.add(current.objectNumber);
    const entries = dictionaryOf(context.document, current, "大纲条目");
    // 走错进页树就会把页对象当书签数；别等 `/Count` 兜底——页数与大头条数可能刚好相等。
    const type = nameOf(entries, "Type");
    if (type === "/Page" || type === "/Pages") {
      throw failOf(`大纲条目 ${String(current.objectNumber)} 是页树节点（/Type ${type}）`);
    }
    count += 1 + countItemsOf(context, referenceOf(entries, "First"));
    current = referenceOf(entries, "Next");
  }
  return count;
};

/**
 * 条目数报的是**产物真值**：`display: none` 的标题在打印稿里仍是 `h1`，但 Chrome 不为它
 * 生成书签，只有读产物才数得对。`/Count` 是生成方自报数，实走是结构证明的；两者不等说明
 * 产物自相矛盾，挑任何一个都是在替产物撒谎（条目上的 `/Count` 可为负表折叠，取绝对值）。
 */
const outlineCountOf = (document: PDFDocument): number => {
  const outlines = referenceOf(document.catalog, "Outlines");
  // 没有这个键 = 这份文档没开大纲（`--no-outline`，或本来就没有标题），是正常路径而不是错误。
  if (outlines === undefined) return 0;
  const root = dictionaryOf(document, outlines, "/Outlines");
  const walked = countItemsOf({ document, seen: new Set() }, referenceOf(root, "First"));
  const declared = root.get(PDFName.of("Count"));
  if (declared instanceof PDFNumber && Math.abs(declared.asNumber()) !== walked) {
    throw failOf(
      `/Count 自报 ${String(Math.abs(declared.asNumber()))} 条，实走 ${String(walked)} 条`,
    );
  }
  return walked;
};

/**
 * 结构读不出来（不是 PDF、页树断链、`/First` 断链、`/Count` 与实走不等）一律抛 `render_empty`，
 * 不回退 0：回退 0 会把"Chrome 换了输出格式"伪装成"这份文档没有大纲"，是最难查的一类假绿。
 */
export const inspectPdfOf = async (bytes: Uint8Array): Promise<PdfFacts> => {
  const document = await loadOf(bytes);
  try {
    return { pages: document.getPageCount(), outline: outlineCountOf(document) };
  } catch (error: unknown) {
    if (error instanceof HrError) throw error;
    throw new HrError("render_empty", `PDF 结构解析不出：${firstErrorLineOf(messageOf(error))}`);
  }
};
