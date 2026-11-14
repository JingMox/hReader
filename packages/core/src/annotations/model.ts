// 这层管：Annotation 的类型、长度上限、id 生成与脏数据归一；不碰 IO、不读时钟。
// 时间戳一律由调用方传入（`createdAt` 是字符串），本文件没有任何 `new Date()`。

import { sha256Hex } from "../io/digest";

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

/** 长度上限（AC1.1）：超出**截断**并返回诊断，绝不静默丢字段。 */
export const ANCHOR_LIMITS = { exact: 500, prefix: 64, suffix: 64 } as const;
export const NOTE_LIMIT = 2000;

const STATUSES: ReadonlySet<string> = new Set(["pending", "resolved"]);
/** 旧版（M1.x）meta 的 `pending_ai` 一律归一成 `pending`：状态机只有两态。 */
const LEGACY_STATUSES: ReadonlySet<string> = new Set(["pending_ai", "resolved", "pending"]);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringOf = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const intOf = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** `an-<8 hex>`：输入含 `createdAt`，同一位置写两条批注得到两个 id（AC §2-7）。 */
export const annotationIdOf = (input: {
  readonly nodeId: string;
  readonly anchor: TextAnchor;
  readonly createdAt: string;
  /** 裁定 #5：同位置同句两条批注也要两个 id——把 `note` 与该块已有批注数拼进种子。 */
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

/** 只截断、不抛错：太长是作者的输入问题，阅读器要多活一会儿（AC1.1）。 */
export const normalizeAnchor = (raw: unknown): AnchorOutcome | undefined => {
  if (!isRecord(raw)) return undefined;
  const exact = stringOf(raw["exact"]);
  if (exact === undefined) return undefined;
  const diagnostics: string[] = [];
  const take = (field: "prefix" | "suffix"): string => {
    const value = stringOf(raw[field]) ?? "";
    if (value.length <= ANCHOR_LIMITS[field]) return value;
    diagnostics.push(truncatedDiagnostic(field, value.length, ANCHOR_LIMITS[field]));
    return clipped(value, ANCHOR_LIMITS[field]);
  };
  let boundedExact = exact;
  if (exact.length > ANCHOR_LIMITS.exact) {
    diagnostics.push(truncatedDiagnostic("exact", exact.length, ANCHOR_LIMITS.exact));
    boundedExact = clipped(exact, ANCHOR_LIMITS.exact);
  }
  return {
    anchor: {
      exact: boundedExact,
      prefix: take("prefix"),
      suffix: take("suffix"),
      start: intOf(raw["start"]) ?? 0,
    },
    diagnostics,
  };
};

/** 状态只有两态：写路径与读路径必须走同一个归一函数，否则写进 meta 的值和读出来的值会分叉。 */
export const normalizeStatus = (raw: unknown): AnnotationStatus | undefined => {
  const value = stringOf(raw);
  if (value === undefined || !LEGACY_STATUSES.has(value)) return undefined;
  return STATUSES.has(value) ? (value === "resolved" ? "resolved" : "pending") : "pending";
};

const noteOf = (raw: unknown, diagnostics: string[]): string => {
  const value = stringOf(raw) ?? "";
  if (value.length <= NOTE_LIMIT) return value;
  diagnostics.push(`note 长度 ${String(value.length)} 超过 ${String(NOTE_LIMIT)}，已截断`);
  return clipped(value, NOTE_LIMIT);
};

interface ParseOutcome {
  readonly annotation: Annotation;
  readonly diagnostics: readonly string[];
}

/** 旧字段（`targetId`/`comment`）兼容读入：M1.x 的 meta 不能因为升级而读不出来。 */
const nodeIdOf = (raw: Readonly<Record<string, unknown>>): string | undefined =>
  stringOf(raw["nodeId"]) ?? stringOf(raw["targetId"]);

/** 一条脏批注 → 诊断（不是异常）：调用方决定跳过还是展示。 */
export const parseAnnotationOf = (raw: unknown, index: number): ParseOutcome | string => {
  if (!isRecord(raw)) return `annotations[${String(index)}] 不是对象，已跳过`;
  const nodeId = nodeIdOf(raw);
  const createdAt = stringOf(raw["createdAt"]);
  const normalized = normalizeAnchor(raw["anchor"]);
  if (nodeId === undefined) return `annotations[${String(index)}] 缺少 nodeId，已跳过`;
  if (createdAt === undefined) return `annotations[${String(index)}] 缺少 createdAt，已跳过`;
  if (normalized === undefined)
    return `annotations[${String(index)}] 的 anchor.exact 不是字符串，已跳过`;
  const diagnostics = [...normalized.diagnostics];
  const id =
    stringOf(raw["id"]) ?? annotationIdOf({ nodeId, anchor: normalized.anchor, createdAt });
  const status = normalizeStatus(raw["status"]) ?? "pending";
  const resolvedAt = stringOf(raw["resolvedAt"]);
  const resolutionNote = stringOf(raw["resolutionNote"]);
  return {
    annotation: {
      id,
      nodeId,
      anchor: normalized.anchor,
      note: noteOf(raw["note"] ?? raw["comment"], diagnostics),
      status,
      createdAt,
      ...(resolvedAt === undefined ? {} : { resolvedAt }),
      ...(resolutionNote === undefined ? {} : { resolutionNote }),
    },
    diagnostics,
  };
};

/** 新增字段只报**一条**诊断：逐字段刷屏会把真正的错误淹掉（AC2.4）。 */
export const unknownFieldsOf = (raw: unknown): readonly string[] => {
  if (!isRecord(raw)) return [];
  const known = new Set([
    "id",
    "nodeId",
    "targetId",
    "anchor",
    "note",
    "comment",
    "status",
    "createdAt",
    "resolvedAt",
    "resolutionNote",
  ]);
  return Object.keys(raw).filter((key) => !known.has(key));
};
