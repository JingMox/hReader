// 这层管：Annotation 的类型、长度上限、id 生成与脏数据归一；不碰 IO、不读时钟。
// 时间戳一律由调用方传入（`createdAt` 是字符串），本文件没有任何 `new Date()`。

import { z } from "zod";

import { sha256Hex } from "../io/digest";
import { jsonObject, looseString } from "../schema";

/** 一段文本锚点：`exact` 是要高亮的原文，`prefix`/`suffix` 用来在多处命中时消歧。 */
export interface TextAnchor {
  readonly exact: string;
  readonly prefix: string;
  readonly suffix: string;
  /** 写入时的字符偏移（只是消歧用的提示，不是真相源）。 */
  readonly start: number;
}

export type AnnotationStatus = "pending" | "resolved";

export interface Annotation {
  readonly id: string;
  readonly nodeId: string;
  readonly anchor: TextAnchor;
  readonly note: string;
  readonly status: AnnotationStatus;
  readonly createdAt: string;
  readonly resolvedAt?: string;
  readonly resolutionNote?: string;
}

/** 长度上限：超出**截断**并返回诊断，绝不静默丢字段。 */
export const ANCHOR_LIMITS = { exact: 500, prefix: 64, suffix: 64 } as const;
export const NOTE_LIMIT = 2000;

/** 脏数据读取：除 `exact` 外都不抛，缺省 `""` / `0`，其余校验与截断在 `normalizeAnchor`。 */
const anchorSchema = z.object({
  exact: z.string(),
  prefix: z.string().catch(""),
  suffix: z.string().catch(""),
  start: z.number().int().nonnegative().safe().catch(0),
});

/** 旧版的 `pending_ai` 与 `pending` 合并成同一个待处理态：状态机只有两态。 */
const statusSchema = z
  .enum(["pending", "pending_ai", "resolved"])
  .transform((status): AnnotationStatus => (status === "resolved" ? "resolved" : "pending"));

/** 键全集同时是"未知字段"的判据：新增字段只需改这一处。 */
const annotationSchema = z.object({
  id: looseString,
  nodeId: looseString,
  // 旧版 meta 用 `targetId` / `comment`：升级不能让旧批注读不出来。
  targetId: looseString,
  anchor: z.unknown(),
  note: z.unknown(),
  comment: z.unknown(),
  status: statusSchema.catch("pending"),
  createdAt: looseString,
  resolvedAt: looseString,
  resolutionNote: looseString,
});

/** `an-<8 hex>`：输入含 `createdAt`，同一位置写两条批注得到两个 id。 */
export const annotationIdOf = (input: {
  readonly nodeId: string;
  readonly anchor: TextAnchor;
  readonly createdAt: string;
  /** 同位置同句两条批注也要两个 id——把 `note` 与该块已有批注数拼进种子。 */
  readonly salt?: string;
}): string => {
  const material = [
    input.nodeId,
    input.anchor.start,
    input.anchor.exact,
    input.createdAt,
    input.salt ?? "",
  ].join("\n");
  return `an-${sha256Hex(new TextEncoder().encode(material)).slice(0, 8)}`;
};

const clipped = (value: string, limit: number): string => value.slice(0, limit);

const truncatedDiagnostic = (field: string, length: number, limit: number): string =>
  `anchor.${field} 长度 ${String(length)} 超过 ${String(limit)}，已截断`;

interface AnchorOutcome {
  readonly anchor: TextAnchor;
  readonly diagnostics: readonly string[];
}

/** 只截断、不抛错：太长是作者的输入问题，阅读器要多活一会儿。 */
export const normalizeAnchor = (raw: unknown): AnchorOutcome | undefined => {
  const parsed = anchorSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const { exact, prefix, suffix, start } = parsed.data;
  const diagnostics: string[] = [];
  const bound = (field: keyof typeof ANCHOR_LIMITS, value: string): string => {
    if (value.length <= ANCHOR_LIMITS[field]) return value;
    diagnostics.push(truncatedDiagnostic(field, value.length, ANCHOR_LIMITS[field]));
    return clipped(value, ANCHOR_LIMITS[field]);
  };
  // 诊断顺序固定为 exact → prefix → suffix，与字段在界面上的出现顺序一致。
  return {
    anchor: {
      exact: bound("exact", exact),
      prefix: bound("prefix", prefix),
      suffix: bound("suffix", suffix),
      start,
    },
    diagnostics,
  };
};

/** 状态只有两态：写路径与读路径必须走同一个归一函数，否则写进 meta 的值和读出来的值会分叉。 */
export const normalizeStatus = (raw: unknown): AnnotationStatus | undefined => {
  const parsed = statusSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
};

const noteOf = (raw: unknown, diagnostics: string[]): string => {
  const value = looseString.parse(raw) ?? "";
  if (value.length <= NOTE_LIMIT) return value;
  diagnostics.push(`note 长度 ${String(value.length)} 超过 ${String(NOTE_LIMIT)}，已截断`);
  return clipped(value, NOTE_LIMIT);
};

interface ParseOutcome {
  readonly annotation: Annotation;
  readonly diagnostics: readonly string[];
}

const lifecycleOf = (record: {
  readonly resolvedAt?: string | undefined;
  readonly resolutionNote?: string | undefined;
}): Pick<Annotation, "resolvedAt" | "resolutionNote"> => ({
  ...(record.resolvedAt === undefined ? {} : { resolvedAt: record.resolvedAt }),
  ...(record.resolutionNote === undefined ? {} : { resolutionNote: record.resolutionNote }),
});

/** 一条脏批注 → 诊断（不是异常）：调用方决定跳过还是展示。 */
export const parseAnnotationOf = (raw: unknown, index: number): ParseOutcome | string => {
  const record = annotationSchema.safeParse(raw);
  if (!record.success) return `annotations[${String(index)}] 不是对象，已跳过`;
  const { nodeId = record.data.targetId, createdAt } = record.data;
  if (nodeId === undefined) return `annotations[${String(index)}] 缺少 nodeId，已跳过`;
  if (createdAt === undefined) return `annotations[${String(index)}] 缺少 createdAt，已跳过`;
  const normalized = normalizeAnchor(record.data.anchor);
  if (normalized === undefined) {
    return `annotations[${String(index)}] 的 anchor.exact 不是字符串，已跳过`;
  }
  const diagnostics = [...normalized.diagnostics];
  const id = record.data.id ?? annotationIdOf({ nodeId, anchor: normalized.anchor, createdAt });
  return {
    annotation: {
      id,
      nodeId,
      anchor: normalized.anchor,
      note: noteOf(record.data.note ?? record.data.comment, diagnostics),
      status: record.data.status,
      createdAt,
      ...lifecycleOf(record.data),
    },
    diagnostics,
  };
};

/** 新增字段只报**一条**诊断：逐字段刷屏会把真正的错误淹掉。 */
export const unknownFieldsOf = (raw: unknown): readonly string[] => {
  const record = jsonObject.safeParse(raw);
  if (!record.success) return [];
  return Object.keys(record.data).filter((key) => !Object.hasOwn(annotationSchema.shape, key));
};
