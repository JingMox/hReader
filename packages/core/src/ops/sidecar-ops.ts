// This layer: sidecar annotation ops — add/resolve/reopen/reply/delete, the merged meta+sidecar
// read, and the meta→sidecar migration. Every op resolves the same per-file lock used by patch
// and meta annotations, and none of them ever touches the document's HTML bytes (only migrate's
// second step does, through the existing snapshot + atomic-write pipeline).

import { annotationIdOf, NOTE_LIMIT, normalizeAnchor } from "../annotations/model";
import { docRelocatorOf, type RelocateResult } from "../annotations/relocate";
import {
  replyIdOf,
  SIDECAR_LIMITS,
  type SidecarAnnotation,
  type SidecarAuthor,
  type SidecarReply,
} from "../annotations/sidecar-model";
import { readAnnotations, writeAnnotations } from "../annotations/store";
import type { Annotation, TextAnchor } from "../annotations/model";
import { HrError } from "../hr-error";
import { readSidecarFile, writeSidecarFile } from "../io/annotation-store";
import { writeAtomic } from "../io/atomic";
import { decodeUtf8, encodeUtf8, readBytes } from "../io/bytes";
import type { PatchOptions, PatchTargetInput } from "../io/contracts";
import { pruneSnapshots, writeSnapshot } from "../io/history";
import { runLocked } from "../io/lock";
import { historyDirOf, resolveTarget, type ResolvedTarget } from "../io/paths";
import type { PatchDeps } from "../io/ports";

function fail(message: string): never {
  throw new HrError("invalid_payload", message);
}

// ---- shared write template: read-modify-write inside the per-file lock ----

interface Update<T> {
  readonly next: readonly SidecarAnnotation[];
  readonly result: T;
}

const updateSidecar = async <T>(
  input: PatchTargetInput,
  deps: PatchDeps,
  options: PatchOptions,
  work: (current: readonly SidecarAnnotation[], now: string) => Update<T>,
): Promise<{ readonly result: T; readonly diagnostics: readonly string[] }> => {
  const target = await resolveTarget(input, deps.fs);
  return await runLocked(target, deps, options, async () => {
    const file = await readSidecarFile(target, deps);
    const { next, result } = work(file.annotations, deps.clock.now().toISOString());
    await writeSidecarFile(target, deps, file, next);
    return { result, diagnostics: file.diagnostics };
  });
};

// `unknown` not `SidecarAuthor | undefined`: a caller through any/JSON boundary can pass any
// string, and the check must stay a real runtime gate, not a statically-dead comparison.
const authorOf = (raw: unknown): SidecarAuthor => {
  if (raw === undefined) return "user";
  if (raw !== "user" && raw !== "agent") fail("author 只接受 user/agent");
  return raw;
};

// ---- add ----

export interface AddSidecarInput extends PatchTargetInput {
  readonly nodeId?: string | undefined;
  readonly selector?: string | undefined;
  readonly anchor: TextAnchor;
  readonly note: string;
  readonly author?: SidecarAuthor | undefined;
}

export interface SidecarWriteResult {
  readonly annotation: SidecarAnnotation;
  readonly diagnostics: readonly string[];
  readonly changed: true;
}

const newSidecarOf = (
  input: AddSidecarInput,
  now: string,
  current: readonly SidecarAnnotation[],
): SidecarAnnotation => {
  const normalized = normalizeAnchor(input.anchor);
  if (normalized === undefined) fail("anchor.exact 缺失");
  const anchor = normalized.anchor;
  if (anchor.exact === "") fail("anchor.exact 不能为空");
  // Position basis for the id hash: the nodeId when there is one, else the selector path.
  const basis = input.nodeId ?? input.selector;
  if (basis === undefined) fail("nodeId 与 selector 至少给一个");
  if (input.nodeId !== undefined && input.nodeId === "") fail("nodeId 不能为空");
  if (input.selector !== undefined && input.selector === "") fail("selector 不能为空");
  if (input.note.length > NOTE_LIMIT) fail(`note 超过 ${String(NOTE_LIMIT)} 字符`);
  if (current.length >= SIDECAR_LIMITS.annotations) {
    fail(`批注数超过 ${String(SIDECAR_LIMITS.annotations)} 上限`);
  }
  const salt = [
    input.note,
    String(current.filter((item) => (item.nodeId ?? item.selector) === basis).length),
    String(current.length),
  ].join("\u0000");
  return {
    id: annotationIdOf({ nodeId: basis, anchor, createdAt: now, salt }),
    ...(input.nodeId === undefined ? {} : { nodeId: input.nodeId }),
    ...(input.selector === undefined ? {} : { selector: input.selector }),
    anchor,
    note: input.note,
    status: "pending",
    createdAt: now,
    author: authorOf(input.author),
    replies: [],
  };
};

export const addSidecarAnnotation = async (
  input: AddSidecarInput,
  deps: PatchDeps,
  options: PatchOptions = {},
): Promise<SidecarWriteResult> => {
  const { result, diagnostics } = await updateSidecar(input, deps, options, (current, now) => {
    const added = newSidecarOf(input, now, current);
    return { next: [...current, added], result: added };
  });
  return { annotation: result, diagnostics, changed: true };
};

// ---- id-keyed patches (resolve / reopen / reply / delete) ----

export interface SidecarIdInput extends PatchTargetInput {
  readonly id: string;
}

const patchById = (
  current: readonly SidecarAnnotation[],
  id: string,
  patch: (item: SidecarAnnotation) => SidecarAnnotation,
): Update<SidecarAnnotation> => {
  const hit = current.find((item) => item.id === id);
  if (hit === undefined) throw new HrError("not_found", `批注不存在：${id}`);
  const next = patch(hit);
  return { next: current.map((item) => (item.id === id ? next : item)), result: next };
};

export interface ResolveSidecarInput extends SidecarIdInput {
  readonly resolutionNote?: string | undefined;
}

export const resolveSidecarAnnotation = async (
  input: ResolveSidecarInput,
  deps: PatchDeps,
  options: PatchOptions = {},
): Promise<SidecarWriteResult> => {
  const { result, diagnostics } = await updateSidecar(input, deps, options, (current, now) =>
    patchById(current, input.id, (item) => ({
      ...item,
      status: "resolved",
      resolvedAt: now,
      ...(input.resolutionNote === undefined ? {} : { resolutionNote: input.resolutionNote }),
    })),
  );
  return { annotation: result, diagnostics, changed: true };
};

export const reopenSidecarAnnotation = async (
  input: SidecarIdInput,
  deps: PatchDeps,
  options: PatchOptions = {},
): Promise<SidecarWriteResult> => {
  const { result, diagnostics } = await updateSidecar(input, deps, options, (current) =>
    patchById(current, input.id, (item) => ({ ...item, status: "pending" })),
  );
  return { annotation: result, diagnostics, changed: true };
};

export interface ReplySidecarInput extends SidecarIdInput {
  readonly note: string;
  readonly author?: SidecarAuthor | undefined;
}

export interface SidecarReplyResult {
  readonly annotation: SidecarAnnotation;
  readonly reply: SidecarReply;
  readonly diagnostics: readonly string[];
  readonly changed: true;
}

export const replySidecarAnnotation = async (
  input: ReplySidecarInput,
  deps: PatchDeps,
  options: PatchOptions = {},
): Promise<SidecarReplyResult> => {
  const author = authorOf(input.author);
  if (input.note.length > NOTE_LIMIT) fail(`note 超过 ${String(NOTE_LIMIT)} 字符`);
  const { result, diagnostics } = await updateSidecar(input, deps, options, (current, now) => {
    const hit = current.find((item) => item.id === input.id);
    if (hit === undefined) throw new HrError("not_found", `批注不存在：${input.id}`);
    if (hit.replies.length >= SIDECAR_LIMITS.replies) {
      fail(`回复数超过 ${String(SIDECAR_LIMITS.replies)} 上限`);
    }
    const reply: SidecarReply = {
      id: replyIdOf({
        annotationId: hit.id,
        note: input.note,
        createdAt: now,
        ordinal: hit.replies.length,
      }),
      author,
      note: input.note,
      createdAt: now,
    };
    const annotation: SidecarAnnotation = { ...hit, replies: [...hit.replies, reply] };
    return {
      next: current.map((item) => (item.id === input.id ? annotation : item)),
      result: { annotation, reply },
    };
  });
  return { ...result, diagnostics, changed: true };
};

export const deleteSidecarAnnotation = async (
  input: SidecarIdInput,
  deps: PatchDeps,
  options: PatchOptions = {},
): Promise<SidecarWriteResult> => {
  const { result, diagnostics } = await updateSidecar(input, deps, options, (current) => {
    const hit = current.find((item) => item.id === input.id);
    if (hit === undefined) throw new HrError("not_found", `批注不存在：${input.id}`);
    return { next: current.filter((item) => item.id !== input.id), result: hit };
  });
  return { annotation: result, diagnostics, changed: true };
};

// ---- merged read ----

export interface DocAnnotationEntry {
  readonly source: "meta" | "sidecar";
  readonly annotation: SidecarAnnotation;
  /** Relocation is a value too: a lost anchor rides along, the annotation is never deleted. */
  readonly anchor: RelocateResult;
}

export interface DocAnnotationsResult {
  readonly annotations: readonly DocAnnotationEntry[];
  readonly diagnostics: readonly string[];
}

/** Meta records widen losslessly into the sidecar shape: same fields, defaulted author/replies. */
const widenMeta = (annotation: Annotation): SidecarAnnotation => ({
  ...annotation,
  author: "user",
  replies: [],
});

export const listDocAnnotations = async (
  input: PatchTargetInput,
  deps: PatchDeps,
): Promise<DocAnnotationsResult> => {
  const target = await resolveTarget(input, deps.fs);
  const html = decodeUtf8(await readBytes(deps.fs, target.realPath), target.realPath);
  const meta = readAnnotations(html);
  const file = await readSidecarFile(target, deps);
  const relocate = docRelocatorOf(html);
  const diagnostics = [...meta.diagnostics, ...file.diagnostics];
  const entries: DocAnnotationEntry[] = [];
  const metaIds = new Set<string>();
  for (const annotation of meta.annotations) {
    metaIds.add(annotation.id);
    const widened = widenMeta(annotation);
    entries.push({ source: "meta", annotation: widened, anchor: relocate(widened) });
  }
  for (const annotation of file.annotations) {
    if (metaIds.has(annotation.id)) {
      diagnostics.push(
        `批注 ${annotation.id} 同时存在于 hr-meta 与侧车，以 hr-meta 为准，已忽略侧车条目`,
      );
      continue;
    }
    entries.push({ source: "sidecar", annotation, anchor: relocate(annotation) });
  }
  return { annotations: entries, diagnostics };
};

// ---- migration: sidecar copy first, meta removal second — a crash between loses nothing ----

export interface MigrateResult {
  readonly migrated: number;
  /** Already in the sidecar (id collision): counted, not re-copied — that is what makes re-runs complete. */
  readonly skipped: number;
  readonly diagnostics: readonly string[];
  readonly historyPath: string | null;
  readonly changed: boolean;
}

const migrateInLock = async (target: ResolvedTarget, deps: PatchDeps): Promise<MigrateResult> => {
  const before = await readBytes(deps.fs, target.realPath);
  const html = decodeUtf8(before, target.realPath);
  const meta = readAnnotations(html);
  const diagnostics = [...meta.diagnostics];
  if (meta.annotations.length === 0) {
    return { migrated: 0, skipped: 0, diagnostics, historyPath: null, changed: false };
  }
  const file = await readSidecarFile(target, deps);
  diagnostics.push(...file.diagnostics);
  const existing = new Set(file.annotations.map((item) => item.id));
  const copied = meta.annotations.filter((item) => !existing.has(item.id)).map(widenMeta);
  const skipped = meta.annotations.length - copied.length;
  if (copied.length > 0) {
    await writeSidecarFile(target, deps, file, [...file.annotations, ...copied]);
  }
  // Meta removal goes through the same snapshot → atomic write → prune pipeline as every other
  // annotation write: body bytes stay untouched and the change is undoable.
  const historyPath = await writeSnapshot(
    { dir: historyDirOf(target), workspace: target.workspace, data: before },
    deps,
  );
  const bytes = encodeUtf8(writeAnnotations(html, []));
  await writeAtomic({ path: target.realPath, workspace: target.workspace, data: bytes }, deps);
  await pruneSnapshots(deps, historyDirOf(target));
  return { migrated: copied.length, skipped, diagnostics, historyPath, changed: true };
};

export const migrateMetaAnnotations = async (
  input: PatchTargetInput,
  deps: PatchDeps,
  options: PatchOptions = {},
): Promise<MigrateResult> => {
  const target = await resolveTarget(input, deps.fs);
  return await runLocked(target, deps, options, () => migrateInLock(target, deps));
};
