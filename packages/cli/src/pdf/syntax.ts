// 这层管：把 PDF 产物字节读成"对象表 + trailer"的**语法**层（切对象、读字典、跳串与注释）；
// 语义（哪个键算大纲、数几条）在 `bookmarks.ts`。只读、纯函数。
//
// 只认 Chrome 产物的经典形态：顺序扫明文对象 + 读 `trailer`（**不解析 xref 表**，只用 `startxref` 定位），
// **不是**通用 PDF 解析器：不处理 ObjStm、xref 流、`/Names` 大纲、`/Prev` 增量链——范围窄才敢在认不出时报错。
//
// 扫描必须跳过字面串、十六进制串与注释：标题就是用户内容，`(endobj)`、`(/Next 77 0 R)`、`(50% …)`
// 出现在标题里都是合法文档；在原文上 grep `/Next` 或按 `endobj` 切对象，会把标题当结构读。
//
// 与 `tests/helpers/pdf-scan.ts` **刻意不共用代码**：共用的话“src 读错、oracle 也读错”会一起绿。

import { HrError } from "@hreader/core";

const decoder = new TextDecoder("latin1");

/** 只区分走结构要用的几种值：引用、整数、名字、字典；其余（串/数组/实数/关键字）不透传内容。 */
export type PdfValue =
  | { readonly kind: "reference"; readonly id: number }
  | { readonly kind: "integer"; readonly value: number }
  | { readonly kind: "name"; readonly value: string }
  | { readonly kind: "dictionary"; readonly entries: ReadonlyMap<string, PdfValue> }
  | { readonly kind: "opaque" };

export type PdfEntries = ReadonlyMap<string, PdfValue>;

const OPAQUE: PdfValue = { kind: "opaque" };

/** 语法层只说"结构读不出来"；"大纲"是语义层的语境，由 `bookmarks.ts` 的 `failOf` 补前缀。 */
const failureOf = (reason: string): HrError =>
  new HrError("render_empty", `PDF 结构解析不出：${reason}`);

/** 嵌套上限：真实产物连十层都不到（大纲树靠 `/First`/`/Next` 引用链），40 层足够宽，超了就是畸形字节。 */
const MAX_NESTING = 40;

/** 扫描游标：`index` 单调前进（唯一例外是引用探测时的回溯），`text` 是整份产物的 latin1 解码。 */
interface Cursor {
  readonly text: string;
  index: number;
}

const NAME_END = /[\s()<>[\]{}/%]/u;
const NUMBER = /[-+]?\d*\.?\d+/uy;
const KEYWORD = /[A-Za-z*'"]+/uy;

/** 粘性正则共用一个 `lastIndex`：每次调用都先重置，所以嵌套调用（引用探测）也安全。 */
const matchAt = (pattern: RegExp, cursor: Cursor): string | undefined => {
  pattern.lastIndex = cursor.index;
  const match = pattern.exec(cursor.text);
  if (match === null) return undefined;
  cursor.index = pattern.lastIndex;
  return match[0];
};

/** 跳到下一个记号：空白与 `% … 行尾` 注释都不算记号。 */
const skipSpace = (cursor: Cursor): void => {
  for (;;) {
    const char = cursor.text.charAt(cursor.index);
    if (char === "") return;
    if (char === "%") {
      const end = cursor.text.indexOf("\n", cursor.index);
      cursor.index = end < 0 ? cursor.text.length : end + 1;
    } else if ("\0\t\n\f\r ".includes(char)) {
      cursor.index += 1;
    } else {
      return;
    }
  }
};

/** 字面串 `( … )`：串内 `(`/`)` 可嵌套，`\` 转义后面那个字节（含 `\)`），都要按层数配对。 */
const skipLiteralString = (cursor: Cursor): void => {
  let depth = 0;
  while (cursor.index < cursor.text.length) {
    const char = cursor.text.charAt(cursor.index);
    cursor.index += 1;
    if (char === "\\") {
      cursor.index += 1;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return;
    }
  }
};

const skipHexString = (cursor: Cursor): void => {
  const end = cursor.text.indexOf(">", cursor.index + 1);
  cursor.index = end < 0 ? cursor.text.length : end + 1;
};

/** 读 `/Name`（不含前导 `/`）。前提是当前字节就是 `/`：两个调用处都先判过，少一个死分支。 */
const nameOfHere = (cursor: Cursor): string => {
  const start = cursor.index + 1;
  cursor.index = start;
  while (cursor.index < cursor.text.length && !NAME_END.test(cursor.text.charAt(cursor.index))) {
    cursor.index += 1;
  }
  return cursor.text.slice(start, cursor.index);
};

/** 读到数字返回 `{ value, integral }`：实数不进结构（引用与 `/Count` 都要整数）。 */
const readNumber = (
  cursor: Cursor,
): { readonly value: number; readonly integral: boolean } | undefined => {
  const text = matchAt(NUMBER, cursor);
  if (text === undefined) return undefined;
  return { value: Number(text), integral: !text.includes(".") };
};

const isKeywordEndOf = (cursor: Cursor): boolean =>
  /[A-Za-z0-9]/u.test(cursor.text.charAt(cursor.index + 1));

/**
 * `12 0 R` 是引用，`12` 是整数。引用只取**对象号**：我们只按对象号建索引，generation 不参与定位
 * （Chrome 恒写 `0`，写死 `0` 会把 generation 非 0 的产物误判成断链）。
 */
const numberValueOf = (
  cursor: Cursor,
  first: { readonly value: number; readonly integral: boolean },
): PdfValue => {
  if (!first.integral) return OPAQUE;
  const save = cursor.index;
  skipSpace(cursor);
  const generation = readNumber(cursor);
  if (generation?.integral === true) {
    skipSpace(cursor);
    if (cursor.text.charAt(cursor.index) === "R" && !isKeywordEndOf(cursor)) {
      cursor.index += 1;
      return { kind: "reference", id: first.value };
    }
  }
  cursor.index = save;
  return { kind: "integer", value: first.value };
};

/** 跳不过去的记号：`readValue` 不前进时由调用方保底前进一个字节，免得死循环。 */
const advanceOf = (cursor: Cursor, before: number): void => {
  if (cursor.index === before) cursor.index += 1;
};

const readValue = (cursor: Cursor, nesting: number): PdfValue | undefined => {
  if (nesting > MAX_NESTING) throw failureOf(`嵌套超过 ${String(MAX_NESTING)} 层`);
  skipSpace(cursor);
  const char = cursor.text.charAt(cursor.index);
  if (char === "") return undefined;
  if (char === "<") {
    if (cursor.text.charAt(cursor.index + 1) === "<") return readDictionary(cursor, nesting + 1);
    skipHexString(cursor);
    return OPAQUE;
  }
  if (char === "(") {
    skipLiteralString(cursor);
    return OPAQUE;
  }
  if (char === "[") {
    skipArray(cursor, nesting + 1);
    return OPAQUE;
  }
  if (char === "/") return { kind: "name", value: nameOfHere(cursor) };
  const number = readNumber(cursor);
  return number === undefined ? undefined : numberValueOf(cursor, number);
};

/** 数组只当"不透明内容"跳过，但内部仍走同一套记号扫描：串里的 `]` 不许提前收尾。 */
const skipArray = (cursor: Cursor, nesting: number): void => {
  cursor.index += 1;
  for (;;) {
    skipSpace(cursor);
    const char = cursor.text.charAt(cursor.index);
    if (char === "") return;
    if (char === "]") {
      cursor.index += 1;
      return;
    }
    const before = cursor.index;
    if (readValue(cursor, nesting) === undefined) advanceOf(cursor, before);
  }
};

const readDictionary = (cursor: Cursor, nesting: number): PdfValue => {
  cursor.index += 2;
  const entries = new Map<string, PdfValue>();
  for (;;) {
    skipSpace(cursor);
    if (cursor.text.charAt(cursor.index) === "") return { kind: "dictionary", entries };
    if (cursor.text.charAt(cursor.index) === ">" && cursor.text.charAt(cursor.index + 1) === ">") {
      cursor.index += 2;
      return { kind: "dictionary", entries };
    }
    const key = cursor.text.charAt(cursor.index) === "/" ? nameOfHere(cursor) : undefined;
    if (key === undefined) {
      // 不是 `/Key` 起步：跳一个记号继续，坏字节不该把整份产物卡死在这一处。
      const before = cursor.index;
      if (matchAt(KEYWORD, cursor) === undefined) advanceOf(cursor, before);
      continue;
    }
    entries.set(key, readValue(cursor, nesting) ?? OPAQUE);
  }
};

export interface PdfTrailer {
  readonly offset: number;
  readonly entries: PdfEntries;
}

export interface PdfDocument {
  readonly objects: ReadonlyMap<number, PdfValue>;
  readonly trailers: readonly PdfTrailer[];
  /** 最后一个 `startxref` 的偏移：它之后的 `trailer` 只可能是注释或垃圾，不能当真。 */
  readonly lastStartxref: number | undefined;
}

type PdfToken =
  | { readonly kind: "value"; readonly value: PdfValue }
  | { readonly kind: "keyword"; readonly keyword: string };

/** 写真值（字典/名字/数字/引用…），认不出就 `undefined`；数字留着给 `obj` 之前的对象号计数。 */
const nextTokenOf = (cursor: Cursor): PdfToken | undefined => {
  skipSpace(cursor);
  if (cursor.index >= cursor.text.length) return undefined;
  const char = cursor.text.charAt(cursor.index);
  if (char === "<" || char === "(" || char === "[" || char === "/") {
    const value = readValue(cursor, 0);
    if (value !== undefined) return { kind: "value", value };
  }
  const before = cursor.index;
  const keyword = matchAt(KEYWORD, cursor);
  if (keyword !== undefined) return { kind: "keyword", keyword };
  const number = readNumber(cursor);
  if (number !== undefined) return { kind: "value", value: numberValueOf(cursor, number) };
  advanceOf(cursor, before);
  return undefined;
};

interface ScanState {
  readonly objects: Map<number, PdfValue>;
  readonly trailers: PdfTrailer[];
  /** 最近两个整数：`N G obj` 里的对象号是倒数第二个。 */
  readonly numbers: number[];
  lastStartxref: number | undefined;
  objectId: number | undefined;
}

const absorbValueOf = (state: ScanState, value: PdfValue): void => {
  if (state.objectId !== undefined) {
    state.objects.set(state.objectId, value);
    state.objectId = undefined;
    return;
  }
  if (value.kind !== "integer") return;
  state.numbers.push(value.value);
  if (state.numbers.length > 2) state.numbers.shift();
};

/**
 * `stream` 之后直接跳到 `endstream`：流内容可以是任意字节（里面也能有 `endobj`），不解析。
 */
const absorbKeywordOf = (
  state: ScanState,
  cursor: Cursor,
  keyword: string,
  offset: number,
): void => {
  if (keyword === "obj") {
    state.objectId = state.numbers.at(-2);
    state.numbers.length = 0;
  } else if (keyword === "endobj") {
    state.objectId = undefined;
  } else if (keyword === "stream") {
    const end = cursor.text.indexOf("endstream", cursor.index);
    cursor.index = end < 0 ? cursor.text.length : end;
  } else if (keyword === "trailer") {
    const value = readValue(cursor, 0);
    if (value?.kind === "dictionary") state.trailers.push({ offset, entries: value.entries });
  } else if (keyword === "startxref") {
    state.lastStartxref = offset;
  }
};

export const documentOf = (bytes: Uint8Array): PdfDocument => {
  const text = decoder.decode(bytes);
  const cursor: Cursor = { text, index: 0 };
  const state: ScanState = {
    objects: new Map(),
    trailers: [],
    numbers: [],
    lastStartxref: undefined,
    objectId: undefined,
  };
  for (;;) {
    const offset = cursor.index;
    const token = nextTokenOf(cursor);
    if (token === undefined && cursor.index >= text.length) break;
    if (token?.kind === "value") absorbValueOf(state, token.value);
    if (token?.kind === "keyword") absorbKeywordOf(state, cursor, token.keyword, offset);
  }
  return state;
};
