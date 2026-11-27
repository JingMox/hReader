// This layer: the sidecar annotation record (SidecarAnnotation/SidecarReply), its limits,
// and the dirty-read normalization + deterministic serialization of the `.hreader/annotations/<sha1>.json`
// payload. Pure: no IO, no clock. Same philosophy as model.ts — truncation beats rejection,
// and every skipped record lands exactly one human-readable diagnostic.

import { sha256Hex } from "../io/digest";
import { jsonArray, jsonObject, looseString, parseJson } from "../schema";
import {
  NOTE_LIMIT,
  normalizeAnchor,
  normalizeStatus,
  type AnnotationStatus,
  type TextAnchor,
} from "./model";

export type SidecarAuthor = "user" | "agent";

export interface SidecarReply {
  readonly id: string;
  readonly author: SidecarAuthor;
  readonly note: string;
  readonly createdAt: string;
}

/**
 * The unified record: every `Annotation` field with `nodeId` optional (foreign documents have
 * no `data-hr-id`), plus a `selector` structural path and a reply thread. `replies`/`author`
 * are always present after normalization — `undefined` is only an input-side omission.
 */
export interface SidecarAnnotation {
  readonly id: string;
  readonly nodeId?: string;
  readonly selector?: string;
  readonly anchor: TextAnchor;
  readonly note: string;
  readonly status: AnnotationStatus;
  readonly createdAt: string;
  readonly resolvedAt?: string;
  readonly resolutionNote?: string;
  readonly author: SidecarAuthor;
  readonly replies: readonly SidecarReply[];
}

/** Hard capacity caps: exceeding one on write is a refusal, on read a bound. */
export const SIDECAR_LIMITS = {
  annotations: 10_000,
  replies: 100,
  fileBytes: 5 * 1024 * 1024,
} as const;

export const SIDECAR_VERSION = 1;

/** `rp-<8 hex>`: deterministic like `annotationIdOf` — same parent + same millisecond still mints two ids via the reply count. */
export const replyIdOf = (input: {
  readonly annotationId: string;
  readonly note: string;
  readonly createdAt: string;
  readonly ordinal: number;
}): string => {
  const material = [input.annotationId, input.note, input.createdAt, String(input.ordinal)].join(
    "\n",
  );
  return `rp-${sha256Hex(new TextEncoder().encode(material)).slice(0, 8)}`;
};

// ---- dirty read ----

/**
 * Prototype-shaped keys anywhere in the payload are file-level corruption, not per-record
 * dirt: a `__proto__` own property flowing into a merge would silently retarget the prototype
 * instead of landing as data. The scan is an explicit worklist (never recursion): nesting
 * depth is bounded by the file-size cap, and deep input dies earlier in `JSON.parse`.
 */
const DANGEROUS_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

const dangerousKeyOf = (payload: unknown): string | undefined => {
  const pending: unknown[] = [payload];
  for (const node of pending) {
    if (Array.isArray(node)) {
      for (const item of node as readonly unknown[]) pending.push(item);
      continue;
    }
    if (typeof node !== "object" || node === null) continue;
    for (const key of Object.keys(node)) {
      if (DANGEROUS_KEYS.has(key)) return key;
    }
    for (const value of Object.values(node) as readonly unknown[]) pending.push(value);
  }
  return undefined;
};

export interface SidecarParse {
  readonly annotations: readonly SidecarAnnotation[];
  readonly diagnostics: readonly string[];
  /** `true` = the whole file is unusable: the next write must back it up before overwriting. */
  readonly corrupt: boolean;
}

const corruptOf = (diagnostic: string): SidecarParse => ({
  annotations: [],
  corrupt: true,
  diagnostics: [diagnostic],
});

interface ReplyOutcome {
  readonly reply: SidecarReply;
  readonly diagnostics: readonly string[];
}

const clipped = (value: string, limit: number): string => value.slice(0, limit);

const noteOf = (raw: unknown, label: string, diagnostics: string[]): string => {
  const value = looseString.parse(raw) ?? "";
  if (value.length <= NOTE_LIMIT) return value;
  diagnostics.push(`${label} 长度 ${String(value.length)} 超过 ${String(NOTE_LIMIT)}，已截断`);
  return clipped(value, NOTE_LIMIT);
};

const authorOf = (raw: unknown): SidecarAuthor => (raw === "agent" ? "agent" : "user");

const parseReplyOf = (raw: unknown, index: number, parent: number): ReplyOutcome | string => {
  const label = `annotations[${String(parent)}].replies[${String(index)}]`;
  const record = jsonObject.safeParse(raw);
  if (!record.success) return `${label} 不是对象，已跳过`;
  const id = looseString.parse(record.data["id"]);
  if (id === undefined) return `${label} 缺少 id，已跳过`;
  const createdAt = looseString.parse(record.data["createdAt"]);
  if (createdAt === undefined) return `${label} 缺少 createdAt，已跳过`;
  const diagnostics: string[] = [];
  return {
    reply: {
      id,
      author: authorOf(record.data["author"]),
      note: noteOf(record.data["note"], `${label}.note`, diagnostics),
      createdAt,
    },
    diagnostics,
  };
};

interface AnnotationOutcome {
  readonly annotation: SidecarAnnotation;
  readonly diagnostics: readonly string[];
}

const lifecycleOf = (record: {
  readonly resolvedAt?: string | undefined;
  readonly resolutionNote?: string | undefined;
}): Pick<SidecarAnnotation, "resolvedAt" | "resolutionNote"> => ({
  ...(record.resolvedAt === undefined ? {} : { resolvedAt: record.resolvedAt }),
  ...(record.resolutionNote === undefined ? {} : { resolutionNote: record.resolutionNote }),
});

const anchorFieldsOf = (record: {
  readonly nodeId?: string | undefined;
  readonly selector?: string | undefined;
}): Pick<SidecarAnnotation, "nodeId" | "selector"> => ({
  ...(record.nodeId === undefined ? {} : { nodeId: record.nodeId }),
  ...(record.selector === undefined ? {} : { selector: record.selector }),
});

/** One dirty sidecar record → a diagnostic string (the caller decides to skip or show), never a throw. */
const parseEntryOf = (raw: unknown, index: number): AnnotationOutcome | string => {
  const label = `annotations[${String(index)}]`;
  const record = jsonObject.safeParse(raw);
  if (!record.success) return `${label} 不是对象，已跳过`;
  const id = looseString.parse(record.data["id"]);
  if (id === undefined) return `${label} 缺少 id，已跳过`;
  const nodeId = looseString.parse(record.data["nodeId"]);
  const selector = looseString.parse(record.data["selector"]);
  if (nodeId === undefined && selector === undefined) {
    return `${label} 缺少 nodeId/selector，已跳过`;
  }
  const createdAt = looseString.parse(record.data["createdAt"]);
  if (createdAt === undefined) return `${label} 缺少 createdAt，已跳过`;
  const normalized = normalizeAnchor(record.data["anchor"]);
  if (normalized === undefined) return `${label} 的 anchor.exact 不是字符串，已跳过`;
  const diagnostics = [...normalized.diagnostics];
  const replies: SidecarReply[] = [];
  const rawReplies = record.data["replies"];
  if (rawReplies !== undefined) {
    const list = jsonArray.safeParse(rawReplies);
    if (!list.success) {
      diagnostics.push(`${label}.replies 不是数组，已忽略`);
    } else {
      list.data.slice(0, SIDECAR_LIMITS.replies).forEach((item, replyIndex) => {
        const outcome = parseReplyOf(item, replyIndex, index);
        if (typeof outcome === "string") diagnostics.push(outcome);
        else {
          replies.push(outcome.reply);
          diagnostics.push(...outcome.diagnostics);
        }
      });
      if (list.data.length > SIDECAR_LIMITS.replies) {
        diagnostics.push(
          `${label}.replies 长度 ${String(list.data.length)} 超过 ${String(SIDECAR_LIMITS.replies)}，已截断`,
        );
      }
    }
  }
  return {
    annotation: {
      id,
      ...anchorFieldsOf({ nodeId, selector }),
      anchor: normalized.anchor,
      note: noteOf(record.data["note"], `${label}.note`, diagnostics),
      status: normalizeStatus(record.data["status"]) ?? "pending",
      createdAt,
      ...lifecycleOf({
        resolvedAt: looseString.parse(record.data["resolvedAt"]),
        resolutionNote: looseString.parse(record.data["resolutionNote"]),
      }),
      author: authorOf(record.data["author"]),
      replies,
    },
    diagnostics,
  };
};

/** The full key set doubles as the "unknown field" test: new fields only need a change here. */
const KNOWN_FIELDS = new Set([
  "id",
  "nodeId",
  "selector",
  "anchor",
  "note",
  "status",
  "createdAt",
  "resolvedAt",
  "resolutionNote",
  "author",
  "replies",
]);

const unknownFieldsOf = (record: Readonly<Record<string, unknown>>): readonly string[] =>
  Object.keys(record).filter((key) => !KNOWN_FIELDS.has(key));

/**
 * File-level corruption reads as empty + exactly one diagnostic; per-record dirt skips the
 * record with its own diagnostic. `expectedPath` is the workspace-relative POSIX path of the
 * requesting document: a stored `path` that does not match is corruption (the file belongs to
 * another document or was renamed).
 */
export const parseSidecarFile = (text: string, expectedPath: string): SidecarParse => {
  const payload = jsonObject.safeParse(parseJson(text));
  if (!payload.success) return corruptOf("侧车批注文件不是合法 JSON 对象，按空批注处理");
  const danger = dangerousKeyOf(payload.data);
  if (danger !== undefined) {
    return corruptOf(`侧车批注文件含危险键：${danger}，按空批注处理`);
  }
  if (payload.data["version"] !== SIDECAR_VERSION) {
    return corruptOf("侧车批注文件版本不受支持，按空批注处理");
  }
  if (payload.data["path"] !== expectedPath) {
    return corruptOf("侧车批注文件的 path 与目标文档不符，按空批注处理");
  }
  const list = jsonArray.safeParse(payload.data["annotations"]);
  if (!list.success) return corruptOf("侧车批注文件 annotations 不是数组，按空批注处理");
  const annotations: SidecarAnnotation[] = [];
  const diagnostics: string[] = [];
  const seen = new Set<string>();
  const unknown = new Set<string>();
  const capped = list.data.slice(0, SIDECAR_LIMITS.annotations);
  capped.forEach((item, index) => {
    const record = jsonObject.safeParse(item);
    if (record.success) {
      for (const key of unknownFieldsOf(record.data)) unknown.add(key);
    }
    const outcome = parseEntryOf(item, index);
    if (typeof outcome === "string") {
      diagnostics.push(outcome);
      return;
    }
    if (seen.has(outcome.annotation.id)) {
      diagnostics.push(`批注 id 重复：${outcome.annotation.id}，已跳过`);
      return;
    }
    seen.add(outcome.annotation.id);
    annotations.push(outcome.annotation);
    diagnostics.push(...outcome.diagnostics);
  });
  if (list.data.length > SIDECAR_LIMITS.annotations) {
    diagnostics.push(
      `批注数 ${String(list.data.length)} 超过 ${String(SIDECAR_LIMITS.annotations)}，已截断`,
    );
  }
  if (unknown.size > 0) {
    diagnostics.push(`侧车批注文件含未知字段：${[...unknown].join(", ")}（已忽略）`);
  }
  return { annotations, diagnostics, corrupt: false };
};

// ---- deterministic write ----

const replyJson = (reply: SidecarReply) => ({
  id: reply.id,
  author: reply.author,
  note: reply.note,
  createdAt: reply.createdAt,
});

const annotationJson = (annotation: SidecarAnnotation) => ({
  id: annotation.id,
  ...(annotation.nodeId === undefined ? {} : { nodeId: annotation.nodeId }),
  ...(annotation.selector === undefined ? {} : { selector: annotation.selector }),
  anchor: {
    exact: annotation.anchor.exact,
    prefix: annotation.anchor.prefix,
    suffix: annotation.anchor.suffix,
    start: annotation.anchor.start,
  },
  note: annotation.note,
  status: annotation.status,
  createdAt: annotation.createdAt,
  ...(annotation.resolvedAt === undefined ? {} : { resolvedAt: annotation.resolvedAt }),
  ...(annotation.resolutionNote === undefined ? {} : { resolutionNote: annotation.resolutionNote }),
  author: annotation.author,
  replies: annotation.replies.map(replyJson),
});

/** Fixed field order + unescaped CJK: the same store produces the same bytes twice (diff/audit friendly). */
export const serializeSidecarFile = (
  path: string,
  annotations: readonly SidecarAnnotation[],
): string =>
  JSON.stringify({
    version: SIDECAR_VERSION,
    path,
    annotations: annotations.map(annotationJson),
  });
