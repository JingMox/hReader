// 这层管：从 PDF 产物字节里数大纲（书签）条目；只读、纯函数，读不出来一律抛 `render_empty`。
//
// 切对象/跳串与注释这些语法活儿在 `syntax.ts`，这里只做语义：从哪进树、什么算一条、和 `/Count` 对账。
//
// 与 `tests/helpers/pdf-scan.ts` **刻意不共用代码**：那份是测试侧独立 oracle，共用的话"src 读错、
// oracle 也读错"会一起绿。

import { HrError } from "@hreader/core";
import { documentOf, type PdfDocument, type PdfEntries } from "./syntax";

/** 语法层的前缀是“PDF 结构解析不出：”；这里补上“大纲”这个语义语境，用户看到的仍是一句话。 */
const failOf = (reason: string): HrError =>
  new HrError("render_empty", `PDF 大纲结构解析不出：${reason}`);

const entriesOf = (document: PdfDocument, id: number, what: string): PdfEntries => {
  const value = document.objects.get(id);
  if (value === undefined) throw failOf(`找不到 ${what} 对象 ${String(id)}`);
  if (value.kind !== "dictionary") throw failOf(`${what} 对象 ${String(id)} 不是字典`);
  return value.entries;
};

const referenceOf = (entries: PdfEntries, key: string): number | undefined => {
  const value = entries.get(key);
  return value?.kind === "reference" ? value.id : undefined;
};

const integerOf = (entries: PdfEntries, key: string): number | undefined => {
  const value = entries.get(key);
  return value?.kind === "integer" ? value.value : undefined;
};

const nameOf = (entries: PdfEntries, key: string): string | undefined => {
  const value = entries.get(key);
  return value?.kind === "name" ? value.value : undefined;
};

/**
 * 取最新 trailer：增量更新往文件尾追加新 trailer，最后一个才是权威。
 * 只认最后一个 `startxref` **之前** 的 trailer——文末写一行 `% trailer << /Root 99 0 R >>`
 * 就能把“全文最后一个 trailer”骗走。候选为空时（老产物没写 `startxref`）才退回全文最后一个：
 * 此时候选仍只可能是真 trailer，冒充的都写在 `%` 注释里，已经被 `skipSpace` 整行吞掉了。
 * 这里假定最新 trailer 自带 `/Root`：`/Prev` 链（只有旧 trailer 才带 `/Root`）不支持，
 * 追不到就报"trailer 里没有 /Root"，不猜。
 */
const trailerOf = (document: PdfDocument): PdfEntries => {
  const lastStartxref = document.lastStartxref;
  const candidates =
    lastStartxref === undefined
      ? document.trailers
      : document.trailers.filter(({ offset }) => offset < lastStartxref);
  const trailer = (candidates.length === 0 ? document.trailers : candidates).at(-1);
  if (trailer === undefined) throw failOf("找不到 trailer");
  return trailer.entries;
};

interface ItemsContext {
  readonly document: PdfDocument;
  /**
   * 见过的条目对象号。**这是唯一的终止守卫，故意不加第二道步数上限**：合法遍历里每个条目
   * 各占一个对象号，所以步数不可能超过产物对象总数，而重复一定在 `seen` 处更早被逮住——
   * 第二道上限按构造就是死分支，只能靠覆盖率豁免养着，得不偿失。
   */
  readonly seen: Set<number>;
}

/** 跟 `/Next` 走同级链、跟 `/First` 进子层；两个引用都没有就是链尾，正常收尾。 */
const countItemsOf = (context: ItemsContext, firstId: number | undefined): number => {
  let count = 0;
  let currentId = firstId;
  while (currentId !== undefined) {
    if (context.seen.has(currentId)) throw failOf(`条目 ${String(currentId)} 被重复引用`);
    context.seen.add(currentId);
    const entries = entriesOf(context.document, currentId, "大纲条目");
    // 走错进页树就会把页对象当书签数；别等 `/Count` 兜底——页数与大头条数可能刚好相等。
    const type = nameOf(entries, "Type");
    if (type === "Page" || type === "Pages") {
      throw failOf(`大纲条目 ${String(currentId)} 是页树节点（/Type /${type}）`);
    }
    count += 1 + countItemsOf(context, referenceOf(entries, "First"));
    currentId = referenceOf(entries, "Next");
  }
  return count;
};

/**
 * 报的是**产物真值**而不是打印稿的估计值：`display: none` 的标题在打印稿里仍是 `h1`，但 Chrome
 * 不为它生成书签，只有读产物才数得对。
 *
 * 结构读不出来（没有 `trailer`、`/First` 断链、`/Count` 与实走不等）一律抛 `render_empty`，不回退 0：
 * 回退 0 会把"Chrome 换了输出格式"伪装成"这份文档没有大纲"，是最难查的一类假绿。
 */
export const bookmarkCountOf = (bytes: Uint8Array): number => {
  const document = documentOf(bytes);
  const catalogId = referenceOf(trailerOf(document), "Root");
  if (catalogId === undefined) throw failOf("trailer 里没有 /Root");
  const outlinesId = referenceOf(entriesOf(document, catalogId, "Catalog"), "Outlines");
  // 没有这个键 = 这份文档没开大纲（`--no-outline`，或本来就没有标题），是正常路径而不是错误。
  if (outlinesId === undefined) return 0;
  const root = entriesOf(document, outlinesId, "/Outlines");
  const walked = countItemsOf({ document, seen: new Set() }, referenceOf(root, "First"));
  // 交叉核对：`/Count` 是生成方自报的，实走是结构证明的；两者不等说明产物自相矛盾，
  // 挑任何一个都是在替产物撒谎。条目上的 `/Count` 可为负（表示折叠），故取绝对值。
  const declared = integerOf(root, "Count");
  if (declared !== undefined && Math.abs(declared) !== walked) {
    throw failOf(`/Count 自报 ${String(Math.abs(declared))} 条，实走 ${String(walked)} 条`);
  }
  return walked;
};
