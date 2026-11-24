// 这层管：批注的落盘编排（读 → 改 meta → 快照 → 原子写 → 裁剪）；不解析 HTML、不做校验。
// 所有写路径与 patch 共用同一条 undo 快照链（AC2.3），只有一处 `writeAtomic`。

import {
  readAnnotations,
  writeAnnotations,
  type Annotation,
  type TextAnchor,
} from "../annotations";
import { annotationIdOf, NOTE_LIMIT, normalizeAnchor } from "../annotations/model";
import { HrError } from "../hr-error";
import { writeAtomic } from "../io/atomic";
import { decodeUtf8, encodeUtf8, readBytes } from "../io/bytes";
import type { PatchOptions, PatchTargetInput } from "../io/contracts";
import { sha256Hex } from "../io/digest";
import { pruneSnapshots, writeSnapshot } from "../io/history";
import { runLocked } from "../io/lock";
import { historyDirOf, resolveTarget, type ResolvedTarget } from "../io/paths";
import type { PatchDeps } from "../io/ports";
import { REVISION_CHARS } from "../server/revision";

export interface AddAnnotationInput extends PatchTargetInput {
  readonly nodeId: string;
  readonly anchor: TextAnchor;
  readonly note: string;
}

export interface AnnotationWriteResult {
  readonly annotation: Annotation;
  readonly revision: string;
  readonly historyPath: string;
  changed: true;
}

function fail(message: string): never {
  throw new HrError("invalid_payload", message);
}

const newAnnotationOf = (
  input: AddAnnotationInput,
  now: string,
  current: readonly Annotation[],
): Annotation => {
  const normalized = normalizeAnchor(input.anchor);
  if (normalized === undefined) fail("anchor.exact 缺失");
  const anchor = normalized.anchor;
  if (input.nodeId === "") fail("nodeId 不能为空");
  if (anchor.exact === "") fail("anchor.exact 不能为空");
  // 长度上限由 `normalizeAnchor` 截断（`clipped`），此处不再重复判定。
  if (input.note.length > NOTE_LIMIT) fail(`note 超过 ${String(NOTE_LIMIT)} 字符`);
  // 种子 = note + 该块已有批注数 + 全篇条数（均为纯输入）：同毫秒同句的两条批注也稳定得到两个 id。
  const salt = [
    input.note,
    String(current.filter((item) => item.nodeId === input.nodeId).length),
    String(current.length),
  ].join("\u0000");
  return {
    id: annotationIdOf({ nodeId: input.nodeId, anchor, createdAt: now, salt }),
    nodeId: input.nodeId,
    anchor,
    note: input.note,
    status: "pending",
    createdAt: now,
  };
};

const rewriteOf = (html: string, next: readonly Annotation[]): string =>
  writeAnnotations(html, next);

/** 读 → 改 → 写回的唯一模板；`mutate` 抛错即"未变化，不落盘"。 */
const writeWith = async (
  target: ResolvedTarget,
  deps: PatchDeps,
  mutate: (html: string) => { readonly next: readonly Annotation[]; readonly added: Annotation },
): Promise<AnnotationWriteResult> => {
  const before = await readBytes(deps.fs, target.realPath);
  const html = decodeUtf8(before, target.realPath);
  const { next, added } = mutate(html);
  const historyPath = await writeSnapshot(
    { dir: historyDirOf(target), workspace: target.workspace, data: before },
    deps,
  );
  const bytes = encodeUtf8(rewriteOf(html, next));
  await writeAtomic({ path: target.realPath, workspace: target.workspace, data: bytes }, deps);
  await pruneSnapshots(deps, historyDirOf(target));
  return {
    annotation: added,
    revision: sha256Hex(bytes).slice(0, REVISION_CHARS),
    historyPath,
    changed: true,
  };
};

/** 新增一条批注：一次原子写 + 一份快照。 */
export const addAnnotation = async (
  input: AddAnnotationInput,
  deps: PatchDeps,
  options: PatchOptions = {},
): Promise<AnnotationWriteResult> => {
  const target = await resolveTarget({ workspace: input.workspace, file: input.file }, deps.fs);
  return runLocked(target, deps, options, async () => {
    const result = await writeWith(target, deps, (html) => {
      const current = readAnnotations(html).annotations;
      const added = newAnnotationOf(input, deps.clock.now().toISOString(), current);
      return { next: [...current, added], added };
    });
    return result;
  });
};

const replacedOf = (
  current: readonly Annotation[],
  id: string,
  patch: (item: Annotation) => Annotation,
): { readonly next: readonly Annotation[]; readonly added: Annotation } => {
  const hit = current.find((item) => item.id === id);
  if (hit === undefined) throw new HrError("not_found", `批注不存在：${id}`);
  const added = patch(hit);
  return { next: current.map((item) => (item.id === id ? added : item)), added };
};

export interface ResolveInput extends PatchTargetInput {
  readonly id: string;
  readonly resolutionNote?: string;
}

const resolvedPatch =
  (now: string, resolutionNote: string | undefined) =>
  (item: Annotation): Annotation => ({
    ...item,
    status: "resolved",
    resolvedAt: now,
    ...(resolutionNote === undefined ? {} : { resolutionNote }),
  });

export const resolveAnnotation = async (
  input: ResolveInput,
  deps: PatchDeps,
  options: PatchOptions = {},
): Promise<AnnotationWriteResult> => {
  const target = await resolveTarget({ workspace: input.workspace, file: input.file }, deps.fs);
  return runLocked(target, deps, options, async () => {
    const patch = resolvedPatch(deps.clock.now().toISOString(), input.resolutionNote);
    return await writeWith(target, deps, (html) =>
      replacedOf(readAnnotations(html).annotations, input.id, patch),
    );
  });
};

export const reopenAnnotation = async (
  input: Omit<ResolveInput, "resolutionNote">,
  deps: PatchDeps,
  options: PatchOptions = {},
): Promise<AnnotationWriteResult> => {
  const target = await resolveTarget({ workspace: input.workspace, file: input.file }, deps.fs);
  return runLocked(target, deps, options, async () =>
    writeWith(target, deps, (html) =>
      replacedOf(readAnnotations(html).annotations, input.id, (item) => ({
        ...item,
        status: "pending",
      })),
    ),
  );
};

export interface ListResult {
  readonly annotations: readonly Annotation[];
  readonly diagnostics: readonly string[];
}

export const listAnnotations = async (
  input: PatchTargetInput,
  deps: PatchDeps,
): Promise<ListResult> => {
  const target = await resolveTarget(input, deps.fs);
  const html = decodeUtf8(await readBytes(deps.fs, target.realPath), target.realPath);
  const read = readAnnotations(html);
  return { annotations: read.annotations, diagnostics: read.diagnostics };
};
