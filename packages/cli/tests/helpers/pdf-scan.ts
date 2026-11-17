// 这层管：从 PDF 字节里读页序与大纲树（**仅测试用**，不进 `src`）；不写 PDF、不导出运行时依赖。
//
// 只应付 Chrome 的产物形态：经典 xref 表 + trailer（`/Size … /Root … 0 R`）、页对象直接可寻、
// 无 ObjStm / 无 XRef 流。扫法是"找 `N 0 obj … endobj` 字典 + 跟 `/Kids`"，不是通用 PDF 解析器。

/** 一个对象号的全部字节（`endobj` 之前的字典/流原文），latin1 解码：PDF 结构层是单字节的。 */
type PdfObjects = ReadonlyMap<number, string>;

/** 大纲条目：`page` 是 1 起的页序（`/Kids` 数组位置 + 1），不是对象号。 */
export interface PdfOutlineNode {
  readonly title: string;
  readonly page: number;
  readonly children: readonly PdfOutlineNode[];
}

export interface PdfScan {
  /** `/Pages` → `/Kids` 摊平后的页对象顺序（数组下标 + 1 就是页序）。 */
  readonly pages: readonly number[];
  /** Catalog 里没有 `/Outlines` 键时是 `undefined`（无 heading 的文档就是这样）。 */
  readonly outline: readonly PdfOutlineNode[] | undefined;
}

const OBJECT = /(\d+) 0 obj\b([\s\S]*?)endobj/gu;

const REF = (body: string, key: string): number | undefined => {
  const match = new RegExp(`/${key}\\s+(\\d+) 0 R`, "u").exec(body);
  return match?.[1] === undefined ? undefined : Number(match[1]);
};

/** 对象号 → 原文；`trailer` 不在任何 `obj…endobj` 里，由 `catalogOf` 单独读。 */
const objectsFromTextOf = (text: string): PdfObjects => {
  const objects = new Map<number, string>();
  for (const match of text.matchAll(OBJECT)) {
    objects.set(Number(match[1]), match[2] ?? "");
  }
  return objects;
};

const textOf = (bytes: Uint8Array): string => new TextDecoder("latin1").decode(bytes);

const requireOf = (objects: PdfObjects, id: number, what: string): string => {
  const body = objects.get(id);
  if (body === undefined) throw new Error(`PDF 里找不到 ${what} 对象 ${String(id)} 0 R`);
  return body;
};

/** `/Root` 写在 trailer 里（不在任何对象体里）：直接扫全文取第一个。 */
const catalogOf = (text: string, objects: PdfObjects): string => {
  const rootId = /\/Root\s+(\d+) 0 R/u.exec(text)?.[1];
  if (rootId === undefined) throw new Error("PDF 的 trailer 里没有 /Root");
  return requireOf(objects, Number(rootId), "/Root");
};

/** `/Kids` 递归摊平：页树节点自己带 `/Kids`，叶子页对象带 `/Type /Page`。 */
const pageOrderOf = (objects: PdfObjects, id: number): readonly number[] => {
  const body = requireOf(objects, id, "/Kids");
  const kids = /\/Kids\s*\[([^\]]*)\]/u.exec(body);
  if (kids === null) return [id];
  return [...(kids[1] ?? "").matchAll(/(\d+) 0 R/gu)].flatMap((match) =>
    pageOrderOf(objects, Number(match[1])),
  );
};

/** `/Title` 的文本串：Chrome 对非 ASCII 标题写 `<FEFF…>`（UTF-16BE），其余写 `(…)` 字面串。 */
const decodeHexOf = (hex: string): string => {
  const digits = hex.replaceAll(/\s/gu, "");
  const bytes: number[] = [];
  for (let index = 0; index + 1 < digits.length; index += 2) {
    bytes.push(Number.parseInt(digits.slice(index, index + 2), 16));
  }
  // `<FEFF…>`：BOM 之后是 UTF-16BE 的双字节序列（高位在前）。
  const start = bytes[0] === 0xfe && bytes[1] === 0xff ? 2 : 0;
  let text = "";
  for (let index = start; index + 1 < bytes.length; index += 2) {
    text += String.fromCharCode(((bytes[index] ?? 0) << 8) | (bytes[index + 1] ?? 0));
  }
  return text;
};

const LITERAL_ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  r: "\r",
  t: "\t",
  b: "\b",
  f: "\f",
  "(": "(",
  ")": ")",
  "\\": "\\",
};

/** 字面串的转义：`\(` `\)` `\\` 与 `\ddd` 八进制；其余 `\x` 按规范原样给 `x`。 */
const decodeLiteralOf = (literal: string): string =>
  literal.replaceAll(/\\(\d{1,3}|[\s\S])/gu, (_whole: string, escape: string) =>
    /^\d+$/u.test(escape)
      ? String.fromCharCode(Number.parseInt(escape, 8))
      : (LITERAL_ESCAPES[escape] ?? escape),
  );

const titleOf = (body: string): string => {
  const hex = /\/Title\s*<([0-9A-Fa-f\s]*)>/u.exec(body);
  if (hex !== null) return decodeHexOf(hex[1] ?? "");
  const literal = /\/Title\s*\(((?:\\.|[^()\\])*)\)/su.exec(body);
  if (literal !== null) return decodeLiteralOf(literal[1] ?? "");
  throw new Error("大纲条目没有 /Title");
};

/** 目的地第一项就是页对象引用；`/Dest` 也可能挂在 `/A << /D [...] >>` 里。不是这形态就报错——回退分支会变死代码。 */
const pageRefOf = (body: string): number => {
  const dest = /\/Dest\s*\[([^\]]*)\]/u.exec(body) ?? /\/D\s*\[([^\]]*)\]/u.exec(body);
  if (dest?.[1] === undefined) throw new Error("大纲条目没有 /Dest（或 /A << /D [...] >>）");
  const first = /^\s*(\d+) 0 R/u.exec(dest[1]);
  if (first?.[1] === undefined) throw new Error(`/Dest 首元素不是页对象引用：${dest[1]}`);
  return Number(first[1]);
};

interface ItemContext {
  readonly objects: PdfObjects;
  readonly pages: readonly number[];
}

/**
 * 沿 `/First` → `/Next` 走同级链，每级递归走子链；`/Parent` 用来核对"孩子真的指回这个父"。
 * 大纲根对象与条目都是普通字典（条目没有 `/Type`），所以只认引用，不认类型名。
 */
const itemsOf = (
  context: ItemContext,
  firstId: number | undefined,
  parentId: number,
): readonly PdfOutlineNode[] => {
  const nodes: PdfOutlineNode[] = [];
  let currentId = firstId;
  while (currentId !== undefined) {
    const body = requireOf(context.objects, currentId, "大纲条目");
    const declared = REF(body, "Parent");
    if (declared !== parentId) {
      throw new Error(
        `大纲条目的 /Parent 不是 ${String(parentId)} 0 R（实际 ${String(declared)} 0 R）`,
      );
    }
    const pageRef = pageRefOf(body);
    const page = context.pages.indexOf(pageRef);
    if (page < 0) throw new Error(`/Dest 指向的 ${String(pageRef)} 0 R 不在 /Kids 页序里`);
    nodes.push({
      title: titleOf(body),
      page: page + 1,
      children: itemsOf(context, REF(body, "First"), currentId),
    });
    currentId = REF(body, "Next");
  }
  return nodes;
};

/** 从产物字节读出页序与大纲树；无 `/Outlines` 键时 `outline` 为 `undefined`。 */
export const pdfScanOf = (bytes: Uint8Array): PdfScan => {
  const text = textOf(bytes);
  const objects = objectsFromTextOf(text);
  const catalog = catalogOf(text, objects);
  const pagesId = REF(catalog, "Pages");
  if (pagesId === undefined) throw new Error("PDF 的 Catalog 里没有 /Pages");
  const pages = pageOrderOf(objects, pagesId);
  const outlineId = REF(catalog, "Outlines");
  if (outlineId === undefined) return { pages, outline: undefined };
  const root = requireOf(objects, outlineId, "/Outlines");
  return { pages, outline: itemsOf({ objects, pages }, REF(root, "First"), outlineId) };
};
