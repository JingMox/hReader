// 这层管：两段文本的字符级 diff（AC4.1/AC4.2）；纯函数、零依赖、零 IO。
// **性能上限写在注释里，因为它决定主线程会不会被锁死**：一侧超过 20 000 字符就不做字符级 LCS。

export type ChunkKind = "same" | "ins" | "del";

export interface TextChunk {
  readonly kind: ChunkKind;
  readonly text: string;
}

/** 字符级比对的**格子数**上限：`(n+1)*(m+1) <= 8_000_000`（每格 4 字节，≈32 MB）。
 * 为什么不按字符数：`20 000 × 20 000` 的表格是 1.5 GB（裁字 #10）；按格子数才能在分配之前就拦住。 */
const DIFF_CELL_LIMIT = 8_000_000;

/** 字符上限（AC4.2 的文案口径）：先于格子数闸门检查，单个块文本超过它直接退化。 */
export const DIFF_CHAR_LIMIT = 20_000;

export interface DiffResult {
  readonly chunks: readonly TextChunk[];
  readonly degraded: boolean;
}

const pushChunk = (chunks: TextChunk[], kind: ChunkKind, text: string): void => {
  if (text === "") return; // 零长度 chunk 永不外泄（AC4.1）
  const last = chunks[chunks.length - 1];
  if (last?.kind === kind) {
    chunks[chunks.length - 1] = { kind, text: last.text + text };
    return;
  }
  chunks.push({ kind, text });
};

/** 表读写的唯一入口：`getUint32` 的返回类型是确定的 `number`（没有"越界取默认"这种分支）。 */
const cellAt = (view: DataView, index: number): number => view.getUint32(index * 4, true);

/** 一行 LCS 表：`table[i][j] = 相同则左上+1，否则下方/右侧取大`。 */
const fillRow = (input: {
  readonly view: DataView;
  readonly before: string;
  readonly after: string;
  readonly i: number;
  readonly cols: number;
}): void => {
  const { view, before, after, i, cols } = input;
  for (let j = after.length - 1; j >= 0; j -= 1) {
    const same = before.charCodeAt(i) === after.charCodeAt(j);
    const value = same
      ? cellAt(view, (i + 1) * cols + j + 1) + 1
      : Math.max(cellAt(view, (i + 1) * cols + j), cellAt(view, i * cols + j + 1));
    view.setUint32((i * cols + j) * 4, value, true);
  }
};

/** 经典 LCS 长度表 + 回填；只在格子数 ≤ 8 000 000 的输入上跑（由 `diffText` 把关）。 */
const lcsDiff = (before: string, after: string): TextChunk[] => {
  const rows = before.length + 1;
  const cols = after.length + 1;
  const view = new DataView(new ArrayBuffer(rows * cols * 4));
  const at = (i: number, j: number): number => cellAt(view, i * cols + j);
  for (let i = before.length - 1; i >= 0; i -= 1) {
    fillRow({ view, before, after, i, cols });
  }
  const chunks: TextChunk[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before.charCodeAt(i) === after.charCodeAt(j)) {
      pushChunk(chunks, "same", before.charAt(i));
      i += 1;
      j += 1;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      pushChunk(chunks, "del", before.charAt(i));
      i += 1;
    } else {
      pushChunk(chunks, "ins", after.charAt(j));
      j += 1;
    }
  }
  pushChunk(chunks, "del", before.slice(i));
  pushChunk(chunks, "ins", after.slice(j));
  return chunks;
};

/** 下标越界时取空串（`slice` 的语义），替代 `lines[index] ?? ""` 的默认值分支。 */
const textAt = (lines: readonly string[], index: number): string =>
  lines.slice(index, index + 1).join("");

/** 退化路径：按**真实行边界**切（换行符粘在前一行尾），重拼必须逐字等于原文（裁定 #16）。 */
const paragraphDiff = (before: string, after: string): TextChunk[] => {
  const left = before.split(/(?<=\n)/u);
  const right = after.split(/(?<=\n)/u);
  const chunks: TextChunk[] = [];
  const max = Math.max(left.length, right.length);
  for (let index = 0; index < max; index += 1) {
    const older = textAt(left, index);
    const newer = textAt(right, index);
    if (older === newer) {
      pushChunk(chunks, "same", older);
      continue;
    }
    pushChunk(chunks, "del", older);
    pushChunk(chunks, "ins", newer);
  }
  return chunks;
};

export const diffText = (before: string, after: string): DiffResult => {
  // 第一道闸：按字符数（与导出常量/文案一致）；第二道闸：按 LCS 表格子数（防 20 000×20 000 的 1.5 GB）。
  const tooLong = after.length > DIFF_CHAR_LIMIT || before.length > DIFF_CHAR_LIMIT;
  const cells = (before.length + 1) * (after.length + 1);
  const degraded = tooLong || cells > DIFF_CELL_LIMIT;
  const chunks = degraded ? paragraphDiff(before, after) : lcsDiff(before, after);
  return { chunks, degraded };
};
