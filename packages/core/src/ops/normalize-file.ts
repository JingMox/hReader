// 这层管：`hr normalize` 的落盘编排（读 → 补 id → 可选原地写回）；不定义 id 算法、不判参数。

import { hasArticle } from "../html/article";
import { injectNodeIds } from "../html/inject";
import { parseHtml } from "../html/parse";
import { serializeHtml } from "../html/serialize";
import { HrError } from "../hr-error";
import { writeAtomic } from "../io/atomic";
import { decodeUtf8, encodeUtf8, readBytes } from "../io/bytes";
import type { PatchOptions } from "../io/contracts";
import { runLocked } from "../io/lock";
import { resolveTarget } from "../io/paths";
import type { PatchDeps } from "../io/ports";

export interface NormalizeInput {
  readonly workspace: string;
  readonly file: string;
  /** `true` = 原地写回；`false` = 只算出结果，磁盘一个字节都不动。 */
  readonly write: boolean;
}

export interface NormalizeResult {
  /** 真实路径：调用方拿它与 `--out`/`stat` 对表。 */
  readonly path: string;
  /** 磁盘上的文档是否还缺 id（写回之后恒为 `false`）。 */
  readonly needsNormalize: boolean;
  /** 本次补了几个 id；已有 `data-hr-id` 的文档恒为 0。 */
  readonly injected: number;
  /** 规范化后的全文；不需要规范化时就是原文（逐字节相同）。 */
  readonly html: string;
  readonly bytes: number;
  readonly changed: boolean;
}

/**
 * 不需要规范化就原样返回原文：`parseHtml` + `serializeHtml` 会把引号/自闭合等写法归一，
 * 拿它覆盖一份本来就合法的文档等于凭空改用户的字节（第二次运行必须 md5 不变）。
 */
const normalizedOf = (original: string): { html: string; injected: number } => {
  const parsed = parseHtml(original);
  if (!hasArticle(parsed)) {
    throw new HrError("invalid_document", "文档里没有 <article>：这不是可规范化的文档");
  }
  const injected = injectNodeIds(parsed);
  return injected.injected.length === 0
    ? { html: original, injected: 0 }
    : { html: serializeHtml(injected.parsed), injected: injected.injected.length };
};

/** 写回走 patch 的同一条锁 + 原子写：normalize 与 patch 抢同一个文件时不许交错。 */
export const normalizeFile = async (
  input: NormalizeInput,
  deps: PatchDeps,
  options: PatchOptions = {},
): Promise<NormalizeResult> => {
  const target = await resolveTarget({ workspace: input.workspace, file: input.file }, deps.fs);
  const original = decodeUtf8(await readBytes(deps.fs, target.realPath), target.realPath);
  const normalized = normalizedOf(original);
  const incomplete = normalized.injected > 0;
  const bytes = encodeUtf8(normalized.html);
  const result: NormalizeResult = {
    path: target.realPath,
    // `needsNormalize` 描述的是**写完之后**磁盘的状态：`--write` 已经把这批 id 落盘，
    // 再把写前算出的 `true` 报回去，用户会以为写回没生效。写失败会抛错，走不到这里。
    needsNormalize: incomplete && !input.write,
    injected: normalized.injected,
    html: normalized.html,
    bytes: bytes.length,
    changed: input.write && incomplete,
  };
  if (!result.changed) return result;
  await runLocked(target, deps, options, async () => {
    await writeAtomic({ path: target.realPath, workspace: target.workspace, data: bytes }, deps);
  });
  return result;
};
